import { beforeEach, expect, it, vi } from "vitest";
import { makeSession } from "../src/security/authorization";
import { hash } from "../src/security/crypto";
import { Store } from "../src/storage/database";
import { normalize } from "../src/tesla/normalization";
import { e, fixture, origin, req, store, vin } from "./helpers/app";

const account = "d".repeat(24);
const driverMcp = "tbm_" + "d".repeat(64);
const telemetryToken = "t".repeat(64);
const bearer = (token: string) => ({ Authorization: "Bearer " + token });
const session = (value: string) => ({
  Cookie: "__Host-ev_session=" + value,
  Origin: origin,
});
const post = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const toolsList = {
  ...post({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  },
};

let credentials: Record<string, Record<string, string>>;
let driverStore: Store;
beforeEach(async () => {
  e.TELEMETRY_INGEST_TOKEN = telemetryToken;
  await e.DB.prepare("INSERT INTO accounts(id, created) VALUES (?, ?)")
    .bind(account, Date.now())
    .run();
  await e.DB.prepare(
    "INSERT INTO mcp_tokens(hash, account, created) VALUES (?, ?, ?)",
  )
    .bind(await hash(driverMcp), account, Date.now())
    .run();
  credentials = {
    operatorBearer: { ...bearer(e.ADMIN_TOKEN!), Origin: origin },
    operatorSession: session(await makeSession(e)),
    driverSession: session(await makeSession(e, account, "user")),
    installationMcp: { ...bearer(e.MCP_TOKEN!), Origin: origin },
    driverMcp: { ...bearer(driverMcp), Origin: origin },
    telemetry: { ...bearer(telemetryToken), Origin: origin },
    anonymous: { Origin: origin },
  };
  driverStore = new Store(e, undefined, account);
  for (const [target, id, battery] of [
    [store, "a".repeat(24), 71],
    [driverStore, "b".repeat(24), 82],
  ] as const) {
    const reading = normalize(
      {
        ...fixture,
        charge_state: {
          ...fixture.charge_state,
          battery_level: battery,
          timestamp: Date.now(),
        },
      },
      id,
      "Fixture car",
      false,
    );
    await target.putMany({ selected: { id, vin }, summary: reading });
  }
});

const call = (credential: string, path: string, init: RequestInit = {}) =>
  req(
    path,
    { ...init, headers: { ...credentials[credential], ...init.headers } },
    false,
  );

// Columns match the credential matrix in docs/HTTP_API.md, plus anonymous.
it.each([
  ["/api/vehicle/cached", {}, [200, 200, 200, 200, 200, 403, 401]],
  ["/auth/status", {}, [200, 200, 200, 403, 403, 403, 401]],
  ["/admin/preferences", {}, [200, 200, 200, 403, 403, 403, 401]],
  ["/api/vehicle/select", post({}), [400, 400, 400, 403, 403, 403, 401]],
  ["/api/telemetry/enable", post({}), [503, 503, 503, 403, 403, 403, 401]],
  ["/account/mcp-tokens", post({}), [200, 200, 200, 403, 403, 403, 401]],
  ["/admin/invites", post({}), [200, 200, 403, 403, 403, 403, 401]],
  ["/account/delete", post({}), [403, 403, 200, 403, 403, 403, 401]],
  ["/admin/session", post({}), [200, 401, 401, 403, 403, 403, 401]],
  ["/mcp", toolsList, [200, 401, 401, 200, 200, 403, 401]],
  [
    "/telemetry/ingest",
    post({ records: [] }),
    [403, 403, 403, 403, 403, 200, 401],
  ],
] as const)("enforces scopes on %s", async (path, init, statuses) => {
  // Delete the fixture driver only after checking that its MCP token is denied.
  for (const [i, credential] of Object.keys(credentials).entries()) {
    if (path === "/account/delete" && credential === "driverSession") continue;
    const response = await call(credential, path, init);
    expect(response.status, credential).toBe(statuses[i]);
    if (path === "/api/vehicle/cached" && response.ok) {
      expect(await response.json()).toMatchObject({
        battery: { percentage: credential.startsWith("driver") ? 82 : 71 },
      });
    }
  }
  if (path === "/account/delete")
    expect((await call("driverSession", path, init)).status).toBe(statuses[2]);
});

it.each(["installationMcp", "driverMcp"])(
  "lets %s save planner state only in its own account",
  async (credential) => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const plan = await call(
      credential,
      "/api/trips",
      post({ legs: [{ to: "Office", distance_km: 40 }] }),
    );
    expect(plan.status).toBe(200);
    const { trip_id } = (await plan.json()) as { trip_id: string };
    const outcome = await call(
      credential,
      "/api/trips/outcome",
      post({ trip_id, actual_end_percentage: 60 }),
    );
    expect(outcome.status).toBe(200);
    const briefing = await call(
      credential,
      "/api/briefings",
      post({
        events: [
          {
            event_id: "commute",
            title: "Commute",
            departs_at: new Date(Date.now() + 60 * 60000).toISOString(),
            total_distance_km: 40,
          },
        ],
      }),
    );
    expect(briefing.status).toBe(200);
    const [own, other] =
      credential === "driverMcp" ? [driverStore, store] : [store, driverStore];
    expect(await own.get("trips")).toMatchObject({
      trips: [{ id: trip_id }],
      outcomes: [{ trip_id }],
    });
    expect(await own.get("briefings")).toMatchObject({
      items: [{ event_id: "commute" }],
    });
    for (const key of ["trips", "briefings"])
      expect(await other.get(key)).toBeNull();
    const otherMethod = await call(credential, "/api/briefings", {
      method: "PATCH",
    });
    expect(otherMethod.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  },
);

it.each(["", "Basic fixture", "Bearer unknown"])(
  "does not use a session when Authorization is invalid (%s)",
  async (Authorization) => {
    for (const [path, init] of [
      ["/mcp", toolsList],
      ["/admin/session", post({})],
      ["/admin/preferences", post({})],
    ] as const) {
      const response = await call("operatorSession", path, {
        ...init,
        headers: {
          ...init.headers,
          Authorization,
          Origin: path === "/admin/session" ? origin : "https://other.example",
        },
      });
      expect(response.status, path).toBe(401);
      expect(await response.json()).toMatchObject({
        error: { code: "unauthorized" },
      });
    }
  },
);
