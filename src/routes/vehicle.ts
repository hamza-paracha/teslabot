import type { Env } from "../types";
import { AppError } from "../types";
import { Store } from "../storage/database";
import { hash } from "../security/crypto";
import { TeslaClient, type Vehicle } from "../tesla/client";
import { normalize } from "../tesla/normalization";
import { json, readJson } from "./http";
import {
  appendHistory,
  buildContext,
  defaultPreferences,
  estimateTrip,
  freshness,
  HISTORY_LIMIT,
  HISTORY_RETENTION_MS,
  preferencesSchema,
  tripSchema,
  refreshObservation,
  restrictLocation,
  type Observation,
  type Preferences,
} from "../context/observations";

async function opaque(vehicle: Vehicle) {
  return (await hash(vehicle.vin)).slice(0, 24);
}

export async function vehicleRoute(
  r: Request,
  e: Env,
  store: Store,
): Promise<Response | null> {
  const p = new URL(r.url).pathname;
  const client = new TeslaClient(store);
  if (p === "/api/vehicle/cached" && r.method === "GET") {
    return store.locked("vehicle", async () => {
      const selected = await store.get<{ id: string }>("selected");
      const current = await store.get<Observation>("summary");
      if (!selected || !current || current.vehicle.id !== selected.id)
        throw new AppError("no_cached_observation", 409);
      const safe = restrictLocation(
        refreshObservation(current),
        e.ENABLE_LOCATION === "true",
      );
      return json({
        ...safe,
        data: {
          ...safe.data,
          cache_hit: true,
          may_incur_api_charges: false,
          already_awake: null,
        },
      });
    });
  }
  if (p === "/admin/preferences" && r.method === "GET")
    return json(
      (await store.get<Preferences>("preferences")) ?? defaultPreferences,
    );
  if (p === "/admin/preferences" && r.method === "POST") {
    const parsed = preferencesSchema.safeParse(await readJson(r));
    if (!parsed.success) throw new AppError("invalid_preferences");
    await store.locked("vehicle", async () => {
      await store.put("preferences", parsed.data);
      if (!parsed.data.history_enabled)
        await store.delete("observation_history");
    });
    return json(parsed.data);
  }
  if (p === "/api/vehicle/history" && r.method === "GET") {
    return store.locked("vehicle", async () => {
      const preferences =
        (await store.get<Preferences>("preferences")) ?? defaultPreferences;
      const selected = await store.get<{ id: string }>("selected");
      const records = preferences.history_enabled
        ? ((await store.get<Observation[]>("observation_history")) ?? [])
        : [];
      const observations = records
        .filter(
          (item) =>
            item.vehicle.id === selected?.id &&
            Date.parse(item.data.retrieved_at) >=
              Date.now() - HISTORY_RETENTION_MS,
        )
        .slice(-HISTORY_LIMIT)
        .map((item) => ({
          ...restrictLocation(item, e.ENABLE_LOCATION === "true"),
          data: {
            ...restrictLocation(
              refreshObservation(item),
              e.ENABLE_LOCATION === "true",
            ).data,
            cache_hit: true,
            may_incur_api_charges: false,
            already_awake: null,
          },
        }));
      // Remove expired history on access; no scheduled polling or cleanup task is required.
      if (records.length !== observations.length)
        await store.put("observation_history", observations);
      return json({
        enabled: preferences.history_enabled,
        observations,
        retention_days: 7,
        max_observations: HISTORY_LIMIT,
        data: {
          retrieved_at: new Date().toISOString(),
          may_incur_api_charges: false,
          already_awake: null,
        },
      });
    });
  }
  if (
    (p === "/api/vehicle/context" || p === "/api/vehicle/trip") &&
    r.method === "GET"
  ) {
    const input = p.endsWith("/trip")
      ? tripSchema.safeParse({
          distance_km: Number(new URL(r.url).searchParams.get("distance_km")),
          reserve_percentage: new URL(r.url).searchParams.has(
            "reserve_percentage",
          )
            ? Number(new URL(r.url).searchParams.get("reserve_percentage"))
            : 20,
        })
      : null;
    if (input && !input.success) throw new AppError("invalid_trip_parameters");
    const response = await vehicleRoute(
      new Request(new URL("/api/vehicle/summary", r.url), r),
      e,
      store,
    );
    if (!response) throw new AppError("observation_unavailable", 503);
    const current = (await response.json()) as Observation;
    if (input?.success) return json(estimateTrip(current, input.data));
    return json(
      buildContext(
        current,
        await store.get<Observation>("previous_summary"),
        (await store.get<Preferences>("preferences")) ?? defaultPreferences,
      ),
    );
  }

  if (p === "/api/vehicles" && r.method === "GET") {
    let vehicles = await store.get<{ vehicles: Vehicle[]; at: number }>(
      "vehicles",
    );
    if (!vehicles || Date.now() - vehicles.at > 300000) {
      vehicles = { vehicles: await client.vehicles(), at: Date.now() };
      await store.put("vehicles", vehicles);
    }
    // Never silently change an existing selection; explicit selection is required even for one car.
    return json({
      vehicles: await Promise.all(
        vehicles.vehicles.map(async (v) => ({
          id: await opaque(v),
          display_name: v.display_name ?? null,
          state: v.state,
        })),
      ),
      data: {
        observed_at: new Date(vehicles.at).toISOString(),
        is_stale: Date.now() - vehicles.at > 300000,
        may_incur_api_charges: false,
        already_awake: null,
      },
    });
  }
  if (p === "/api/vehicle/select" && r.method === "POST") {
    const body = (await readJson(r)) as { id?: string };
    if (!body || typeof body.id !== "string" || !/^[a-f0-9]{24}$/.test(body.id))
      throw new AppError("invalid_vehicle_identifier");
    await store.locked("vehicle", async () => {
      const list = await client.vehicles();
      const candidates = await Promise.all(
        list.map(async (v) => ({ v, id: await opaque(v) })),
      );
      const found = candidates.find((v) => v.id === body.id);
      if (!found) throw new AppError("vehicle_not_authorized", 403);
      await store.put("selected", { id: found.id, vin: found.v.vin });
      await store.delete("summary");
      await store.delete("previous_summary");
      await store.delete("observation_history");
    });
    await store.audit("vehicle_selected");
    return json({ selected: true });
  }
  if (p === "/api/vehicle/changes" && r.method === "GET") {
    return store.locked("vehicle", async () => {
      const previous =
          await store.get<ReturnType<typeof normalize>>("previous_summary"),
        current = await store.get<ReturnType<typeof normalize>>("summary");
      if (!previous || !current)
        throw new AppError("two_observations_required", 409);
      const changes: Record<string, unknown> = {};
      for (const section of [
        "vehicle",
        "battery",
        "charging",
        "climate",
        "location",
      ] as const) {
        if (section === "location" && e.ENABLE_LOCATION !== "true") continue;
        const old = previous[section],
          now = current[section];
        if (JSON.stringify(old) !== JSON.stringify(now))
          changes[section] = { before: old ?? null, after: now ?? null };
      }
      return json({
        vehicle: current.vehicle,
        changes,
        previous_observed_at: previous.data.observed_at,
        data: {
          ...current.data,
          ...freshness(current.data.observed_at),
          cache_hit: true,
          may_incur_api_charges: false,
          already_awake: null,
        },
      });
    });
  }
  const match = p.match(
    /^\/api\/vehicle(?:\/(battery|charging|location|climate|summary))?$/,
  );
  if (match && r.method === "GET") {
    const field = match[1] ?? "vehicle";
    if (field === "location" && e.ENABLE_LOCATION !== "true")
      throw new AppError("location_not_enabled", 403);
    let summary = await store.locked("vehicle", async () => {
      const selected = await store.get<{ id: string; vin: string }>("selected");
      if (!selected) throw new AppError("select_vehicle_first", 409);
      let cached = await store.get<ReturnType<typeof normalize>>("summary");
      if (
        cached &&
        Date.now() - Date.parse(cached.data.retrieved_at) <
          Number(e.CACHE_TTL_SECONDS) * 1000
      )
        return {
          ...cached,
          data: {
            ...refreshObservation(cached).data,
            is_stale:
              cached.data.is_stale ||
              cached.data.observed_at === null ||
              Date.now() - Date.parse(cached.data.observed_at) > 300000,
            cache_hit: true,
            may_incur_api_charges: false,
            already_awake: null,
          },
        };
      try {
        const v = await client.vehicle(selected.vin);
        if (v.state !== "online")
          throw new AppError(
            v.state === "asleep" ? "vehicle_asleep" : "vehicle_offline",
            409,
          );
        const location =
          e.ENABLE_LOCATION === "true" && !v.granular_access?.hide_private;
        const endpoints = [
          "charge_state",
          "climate_state",
          "vehicle_state",
          ...(location ? ["location_data"] : []),
        ].join(";");
        const raw = await client.get(
          "/api/1/vehicles/" +
            selected.vin +
            "/vehicle_data?endpoints=" +
            encodeURIComponent(endpoints),
          "data",
        );
        const result = normalize(raw, selected.id, v.display_name, location);
        const writes: Record<string, unknown> = { summary: result };
        if (cached) writes.previous_summary = cached;
        const preferences =
          (await store.get<Preferences>("preferences")) ?? defaultPreferences;
        if (preferences.history_enabled)
          writes.observation_history = appendHistory(
            (await store.get<Observation[]>("observation_history")) ?? [],
            result,
          );
        await store.putMany(writes);
        await store.audit("vehicle_data_refreshed");
        return result;
      } catch (error) {
        if (cached && error instanceof AppError)
          return {
            ...cached,
            data: {
              ...cached.data,
              is_stale: true,
              cache_hit: true,
              may_incur_api_charges: true,
              refresh_error: error.code,
              already_awake: null,
            },
          };
        throw error;
      }
    });
    summary = restrictLocation(
      summary,
      e.ENABLE_LOCATION === "true",
    ) as typeof summary;
    if (field === "summary") return json(summary);
    if (field === "location" && !("location" in summary))
      throw new AppError("location_unavailable", 403);
    return json({
      vehicle: summary.vehicle,
      [field]: summary[field as keyof typeof summary] ?? null,
      data: summary.data,
    });
  }
  return null;
}
