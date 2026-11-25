import { z } from "zod";
import type { Env } from "../types";
import { AppError } from "../types";
import { Store } from "../storage/database";
import { hash } from "../security/crypto";
import type { Principal } from "../security/authorization";
import { TeslaClient } from "../tesla/client";
import { json, readJson } from "./http";
import {
  appendHistory,
  defaultPreferences,
  type Observation,
  type Preferences,
} from "../context/observations";
import {
  applyTelemetry,
  emptyClock,
  recordTime,
  telemetryOnline,
  type SignalClock,
  LOCATION_FIELDS,
  TELEMETRY_FIELDS,
  type TelemetryPayload,
} from "../telemetry/mapping";

const CONFIG_DAYS = 90;
const ROTATE_MS = 30 * 60000;
export interface TelemetryState {
  enabled_at: string;
  expires_at: string;
  connected: boolean | null;
  last_record_at: string | null;
  rotated_at: string | null;
  // Ordering and acknowledgment state; internal, not returned.
  clock?: SignalClock;
  last_batch_id?: string;
}
const batchIdSchema = z.uuid();
const ingestSchema = z
  .object({
    records: z
      .array(
        z
          .object({
            topic: z.string().max(100),
            payload: z.record(z.string(), z.unknown()),
          })
          .strict()
          .refine(
            ({ topic, payload }) =>
              topic.split("_").pop() !== "V" ||
              payload.data == null ||
              (Array.isArray(payload.data) &&
                payload.data.every((item) => item && typeof item === "object")),
          ),
      )
      .max(200),
  })
  .strict();

export const telemetryAvailable = (e: Env) =>
  !!(
    e.TELEMETRY &&
    e.TELEMETRY_HOSTNAME &&
    e.TELEMETRY_CA &&
    e.TELEMETRY_RELAY_TOKEN &&
    e.TELEMETRY_RELAY_TOKEN.length >= 32
  );
const pairingUrl = (e: Env) =>
  "https://tesla.com/_ak/" + new URL(e.APP_ORIGIN).hostname;
const vinHash = (vin: string) => hash("vin:" + vin);

// Remove the configuration from the car and stop accepting its records.
// Tesla is told even when no mapping row exists: an enable can configure the
// car and then lose its lease before saving the mapping. Without a Tesla token
// nothing could have configured it.
export async function disableTelemetry(e: Env, store: Store) {
  const stored = await store.getMany(["selected", "owner_tokens"]);
  const selected: { id: string; vin: string } | null = stored.selected;
  const mapped = await e.DB.prepare(
    "SELECT vin_hash FROM telemetry_vehicles WHERE account=?",
  )
    .bind(store.account)
    .first();
  if (!mapped && !(selected && stored.owner_tokens)) return false;
  // A car mapped to another account is that account's to disable.
  if (
    !mapped &&
    (await e.DB.prepare(
      "SELECT 1 FROM telemetry_vehicles WHERE vin_hash=? AND account<>?",
    )
      .bind(await vinHash(selected!.vin), store.account)
      .first())
  )
    return false;
  try {
    if (selected)
      await new TeslaClient(store).request(
        "DELETE",
        `/api/1/vehicles/${selected.vin}/fleet_telemetry_config`,
      );
  } finally {
    await e.DB.batch([
      e.DB.prepare("DELETE FROM telemetry_vehicles WHERE account=?").bind(
        store.account,
      ),
      store.deleteKeys(["telemetry_state"]),
    ]);
  }
  return !!mapped;
}

export async function telemetryRoute(
  r: Request,
  e: Env,
  store: Store,
  principal: Principal,
): Promise<Response | null> {
  const u = new URL(r.url),
    p = u.pathname;
  if (p === "/telemetry/ingest" && r.method === "POST") {
    if (principal.role !== "telemetry")
      throw new AppError("telemetry_credential_required", 403);
    const parsed = ingestSchema.safeParse(await readJson(r, 524288));
    if (!parsed.success) throw new AppError("invalid_telemetry_batch");
    const batchId = r.headers.get("Idempotency-Key");
    if (batchId !== null && !batchIdSchema.safeParse(batchId).success)
      throw new AppError("invalid_telemetry_batch");
    const result = await ingest(e, store, parsed.data.records, batchId);
    return json(result, result.failed_accounts ? 503 : 200);
  }
  if (principal.role === "telemetry") return null;
  if (p === "/api/telemetry" && r.method === "GET") {
    const stored = await store.getMany(["selected", "telemetry_state"]);
    const mapped = await e.DB.prepare(
      "SELECT vehicle_id FROM telemetry_vehicles WHERE account=?",
    )
      .bind(store.account)
      .first<{ vehicle_id: string }>();
    const result: Record<string, unknown> = {
      available: telemetryAvailable(e),
      enabled: !!mapped && mapped.vehicle_id === stored.selected?.id,
      pairing_url: pairingUrl(e),
      state: stored.telemetry_state && {
        ...stored.telemetry_state,
        clock: undefined,
        last_batch_id: undefined,
      },
      fields: Object.keys(TELEMETRY_FIELDS),
    };
    // Checking Tesla is explicit, since each call counts against the budget.
    if (u.searchParams.get("check") === "true" && stored.selected) {
      const client = new TeslaClient(store);
      const vin = stored.selected.vin;
      const [config, errors] = await Promise.allSettled([
        client.get(`/api/1/vehicles/${vin}/fleet_telemetry_config`),
        client.get(`/api/1/vehicles/${vin}/fleet_telemetry_errors`),
      ]);
      const ok = (x: PromiseSettledResult<unknown>) =>
        x.status === "fulfilled" ? x.value : null;
      const c = ok(config) as {
        synced?: boolean;
        limit_reached?: boolean;
        key_paired?: boolean;
      } | null;
      result.tesla = {
        synced: c?.synced ?? null,
        limit_reached: c?.limit_reached ?? null,
        key_paired: c?.key_paired ?? null,
        errors:
          (ok(errors) as { fleet_telemetry_errors?: unknown[] } | null)
            ?.fleet_telemetry_errors ?? null,
      };
    }
    return json(result);
  }
  if (p === "/api/telemetry/enable" && r.method === "POST") {
    if (principal.role === "reader") throw new AppError("read_only_token", 403);
    if (!telemetryAvailable(e))
      throw new AppError("telemetry_not_configured", 503);
    return store.locked(
      "telemetry",
      async () => json(await enable(e, store)),
      10000,
    );
  }
  if (p === "/api/telemetry/disable" && r.method === "POST") {
    if (principal.role === "reader") throw new AppError("read_only_token", 403);
    const removed = await store.locked(
      "telemetry",
      () => disableTelemetry(e, store),
      10000,
    );
    await store.audit("telemetry_disabled");
    return json({ enabled: false, removed });
  }
  return null;
}

async function enable(e: Env, store: Store) {
  const selected = await store.get<{ id: string; vin: string }>("selected");
  if (!selected) throw new AppError("select_vehicle_first", 409);
  const key = await vinHash(selected.vin);
  const other = await e.DB.prepare(
    "SELECT account FROM telemetry_vehicles WHERE vin_hash=? AND account<>?",
  )
    .bind(key, store.account)
    .first();
  if (other) throw new AppError("telemetry_vehicle_in_use", 409);
  const client = new TeslaClient(store);
  const token = await client.ownerToken();
  await client.reserve("metadata", 0);
  const location = e.ENABLE_LOCATION === "true";
  const expires = Date.now() + CONFIG_DAYS * 86400000;
  let response: Response;
  try {
    response = await e.TELEMETRY!.fetch(
      "https://telemetry.internal/configure",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + e.TELEMETRY_RELAY_TOKEN,
          "X-Tesla-Authorization": "Bearer " + token.access_token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          vins: [selected.vin],
          config: {
            hostname: e.TELEMETRY_HOSTNAME,
            port: Number(e.TELEMETRY_PORT || 443),
            ca: e.TELEMETRY_CA,
            fields: {
              ...TELEMETRY_FIELDS,
              ...(location ? LOCATION_FIELDS : {}),
            },
            alert_types: ["service"],
            prefer_typed: true,
            exp: Math.floor(expires / 1000),
          },
        }),
      },
    );
  } catch {
    throw new AppError("telemetry_server_unavailable", 502);
  }
  const body = (await response.json().catch(() => null)) as {
    response?: {
      updated_vehicles?: number;
      skipped_vehicles?: Record<string, string[]>;
    };
  } | null;
  if (!response.ok || !body?.response)
    throw new AppError(
      response.status === 401
        ? "reauthorization_required"
        : "telemetry_config_rejected",
      response.status === 401 ? 401 : 502,
    );
  const skipped = Object.entries(body.response.skipped_vehicles ?? {}).find(
    ([, vins]) => Array.isArray(vins) && vins.includes(selected.vin),
  );
  if (skipped || !body.response.updated_vehicles) {
    const reason = skipped?.[0] ?? "not_updated";
    throw new AppError(
      reason === "missing_key"
        ? "telemetry_key_not_paired"
        : "telemetry_vehicle_" + reason,
      409,
    );
  }
  const state: TelemetryState = {
    enabled_at: new Date().toISOString(),
    expires_at: new Date(expires).toISOString(),
    connected: null,
    last_record_at: null,
    rotated_at: null,
  };
  await store.putMany({ telemetry_state: state }, [
    e.DB.prepare(
      "INSERT INTO telemetry_vehicles(vin_hash,account,vehicle_id,created) VALUES(?,?,?,?) ON CONFLICT(vin_hash) DO UPDATE SET vehicle_id=excluded.vehicle_id WHERE telemetry_vehicles.account=excluded.account",
    ).bind(key, store.account, selected.id, Date.now()),
  ]);
  await store.audit("telemetry_enabled");
  return {
    enabled: true,
    expires_at: state.expires_at,
    pairing_url: pairingUrl(e),
    note: "The car adopts the configuration the next time it connects; check status with ?check=true.",
  };
}

// Records from the relay. Each VIN is applied under its own account's lock, so
// one slow or failing account does not block the rest of the batch.
async function ingest(
  e: Env,
  root: Store,
  records: Array<{ topic: string; payload: Record<string, unknown> }>,
  batchId: string | null,
) {
  const byVin = new Map<string, typeof records>();
  for (const record of records) {
    const vin = record.payload.vin;
    if (typeof vin !== "string" || !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) continue;
    byVin.set(vin, [...(byVin.get(vin) ?? []), record]);
  }
  const hashes = new Map<string, string>();
  for (const vin of byVin.keys()) hashes.set(await vinHash(vin), vin);
  const { results } = hashes.size
    ? await e.DB.prepare(
        `SELECT vin_hash, account, vehicle_id FROM telemetry_vehicles WHERE vin_hash IN (${[...hashes.keys()].map(() => "?").join(",")})`,
      )
        .bind(...hashes.keys())
        .all<{ vin_hash: string; account: string; vehicle_id: string }>()
    : { results: [] };
  let applied = 0,
    ignored = 0,
    failed = 0;
  const outcomes = await Promise.allSettled(
    results.map(async (row) => {
      const store = root.forAccount(row.account);
      const list = byVin.get(hashes.get(row.vin_hash)!)!;
      return store.locked(
        "vehicle",
        async () => {
          const stored = await store.getMany([
            "selected",
            "summary",
            "preferences",
            "observation_history",
            "telemetry_state",
          ]);
          // Records for a car the account no longer has selected are dropped.
          if (stored.selected?.id !== row.vehicle_id) return;
          let summary: Observation | null = stored.summary;
          const state: TelemetryState | null = stored.telemetry_state;
          if (!state) return;
          if (batchId && state.last_batch_id === batchId)
            return {
              applied: 0,
              ignored: list.filter(
                (record) => record.topic.split("_").pop() === "V",
              ).length,
            };
          const previous = summary;
          const clock = state.clock ?? emptyClock();
          let applied = 0,
            ignored = 0,
            connectivityChanged = false;
          // Records may arrive late, out of order or more than once (the relay
          // retries a batch whose response was lost); only newer values apply.
          for (const record of list) {
            const kind = record.topic.split("_").pop();
            if (kind === "V") {
              const next = applyTelemetry(
                summary,
                record.payload as TelemetryPayload,
                row.vehicle_id,
                e.ENABLE_LOCATION === "true",
                Date.now(),
                clock,
              );
              if (next === summary) ignored++;
              else applied++;
              summary = next;
            } else if (kind === "connectivity") {
              const dated = recordTime(record.payload);
              const last = clock.connectivity;
              if (
                last &&
                (dated === null || (last.at !== null && dated <= last.at))
              )
                continue;
              state.connected = record.payload.status === "CONNECTED";
              clock.connectivity = { at: dated, connected: state.connected };
              connectivityChanged = true;
              if (summary)
                summary = {
                  ...summary,
                  vehicle: {
                    ...summary.vehicle,
                    online: telemetryOnline(clock, summary),
                  },
                };
            }
          }
          if (batchId) state.last_batch_id = batchId;
          if (!applied && !connectivityChanged) {
            if (batchId) await store.put("telemetry_state", state);
            return { applied, ignored };
          }
          state.clock = clock;
          state.last_record_at = new Date().toISOString();
          const writes: Record<string, unknown> = { telemetry_state: state };
          if (summary) writes.summary = summary;
          // Keep change comparisons and history meaningful: rotate at most every
          // 30 minutes instead of on every streamed signal.
          if (
            summary &&
            previous &&
            (!state.rotated_at ||
              Date.now() - Date.parse(state.rotated_at) >= ROTATE_MS)
          ) {
            writes.previous_summary = previous;
            state.rotated_at = new Date().toISOString();
            const preferences: Preferences =
              stored.preferences ?? defaultPreferences;
            if (preferences.history_enabled)
              writes.observation_history = appendHistory(
                stored.observation_history ?? [],
                summary,
              );
          }
          await store.putMany(writes);
          return { applied, ignored };
        },
        5000,
      );
    }),
  );
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") failed++;
    else if (outcome.value) {
      applied += outcome.value.applied;
      ignored += outcome.value.ignored;
    }
  }
  return {
    received: records.length,
    applied,
    ignored,
    unknown_vehicles: hashes.size - results.length,
    failed_accounts: failed,
  };
}
