import type { Env } from "../types";
import { AppError } from "../types";
import { Store } from "../storage/database";
import { TeslaClient } from "../tesla/client";
import {
  discoverVehicles,
  selectionRequired,
  vehicleAccess,
  type VehicleList,
} from "../tesla/vehicles";
import { readiness } from "../context/readiness";
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

// Serve a fresh cached observation, or refresh it from Tesla under the vehicle lock.
// Never wakes the car; an asleep or offline car falls back to the last reading.
export async function currentSummary(
  e: Env,
  store: Store,
  client = new TeslaClient(store),
): Promise<Observation> {
  const ttl = Number(e.CACHE_TTL_SECONDS) * 1000;
  const usable = (
    cached: Observation | null,
    selected: { id: string } | null,
  ) =>
    !!selected &&
    cached?.vehicle.id === selected.id &&
    Date.now() - Date.parse(cached.data.retrieved_at) < ttl;
  const hit = (cached: Observation): Observation => ({
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
  });
  // Fast path: a fresh cached reading is served from one read, without the lock,
  // so parallel tool calls do not collide.
  const peek = await store.getMany(["selected", "summary"]);
  return usable(peek.summary, peek.selected)
    ? hit(peek.summary)
    : await store.locked(
        "vehicle",
        async () => {
          const stored = await store.getMany([
            "selected",
            "summary",
            "preferences",
            "observation_history",
          ]);
          const selected: { id: string; vin: string } | null = stored.selected;
          if (!selected) return selectionRequired(store);
          const cached: Observation | null =
            stored.summary?.vehicle.id === selected.id ? stored.summary : null;
          // Another request may have refreshed while this one waited.
          if (cached && usable(cached, selected)) return hit(cached);
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
            const result = normalize(
              raw,
              selected.id,
              v.display_name,
              location,
            );
            const writes: Record<string, unknown> = { summary: result };
            if (cached) writes.previous_summary = cached;
            const preferences: Preferences =
              stored.preferences ?? defaultPreferences;
            if (preferences.history_enabled)
              writes.observation_history = appendHistory(
                stored.observation_history ?? [],
                result,
              );
            await store.putMany(writes);
            await store.audit("vehicle_data_refreshed");
            return result;
          } catch (error) {
            if (
              cached &&
              error instanceof AppError &&
              ![
                "reauthorization_required",
                "permission_denied",
                "missing_vehicle_data_scope",
                "tesla_not_connected",
                "vehicle_not_found",
                "vehicle_not_authorized",
              ].includes(error.code)
            )
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
        },
        30000,
      );
}

export async function vehicleRoute(
  r: Request,
  e: Env,
  store: Store,
): Promise<Response | null> {
  const p = new URL(r.url).pathname;
  const client = new TeslaClient(store);
  if (p === "/api/vehicle/cached" && r.method === "GET") {
    const { selected, summary: current } = await store.getMany([
      "selected",
      "summary",
    ]);
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
    const retained = (
      records: Observation[],
      selected: { id: string } | null,
    ) =>
      records
        .filter(
          (item) =>
            item.vehicle.id === selected?.id &&
            Date.parse(item.data.retrieved_at) >=
              Date.now() - HISTORY_RETENTION_MS,
        )
        .slice(-HISTORY_LIMIT);
    const stored = await store.getMany([
      "preferences",
      "selected",
      "observation_history",
    ]);
    const preferences: Preferences = stored.preferences ?? defaultPreferences;
    const records: Observation[] = preferences.history_enabled
      ? (stored.observation_history ?? [])
      : [];
    const kept = retained(records, stored.selected);
    // Remove expired history on access; no scheduled polling or cleanup task is required.
    // A concurrent holder of the vehicle lock prunes on its own write, so skip if busy.
    if (records.length !== kept.length)
      await store
        .locked("vehicle", async () => {
          const latest = await store.getMany([
            "selected",
            "observation_history",
          ]);
          if (latest.observation_history)
            await store.put(
              "observation_history",
              retained(latest.observation_history, latest.selected),
            );
        })
        .catch((error) => {
          if (!(error instanceof AppError)) throw error;
        });
    const observations = kept.map((item) => ({
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
    const stored = await store.getMany(["previous_summary", "preferences"]);
    return json(
      buildContext(
        current,
        stored.previous_summary,
        stored.preferences ?? defaultPreferences,
      ),
    );
  }

  if (p === "/api/vehicles" && r.method === "GET") {
    const refresh = new URL(r.url).searchParams.get("refresh");
    if (refresh !== null && refresh !== "true" && refresh !== "false")
      throw new AppError("invalid_refresh_parameter");
    // A fresh cached list needs no Tesla request, so it needs no lock either.
    if (refresh !== "true") {
      const access = await vehicleAccess(store);
      if (!access.data.is_stale)
        return json({ ...access, data: { ...access.data, cache_hit: true } });
    }
    return store.locked("vehicle", async () =>
      json(await discoverVehicles(store, refresh === "true")),
    );
  }
  if (p === "/api/vehicle/select" && r.method === "POST") {
    const body = (await readJson(r)) as { id?: string };
    if (!body || typeof body.id !== "string" || !/^[a-f0-9]{24}$/.test(body.id))
      throw new AppError("invalid_vehicle_identifier");
    await store.locked("vehicle", async () => {
      const discovery = await discoverVehicles(store, true);
      const found = discovery.vehicles.find((v) => v.id === body.id);
      if (!found) throw new AppError("vehicle_not_authorized", 403);
      const list = await store.get<VehicleList>("vehicles");
      const vehicle = list!.vehicles[discovery.vehicles.indexOf(found)];
      await store.putMany({ selected: { id: found.id, vin: vehicle.vin } }, [
        store.deleteKeys([
          "summary",
          "previous_summary",
          "observation_history",
        ]),
      ]);
    });
    await store.audit("vehicle_selected");
    return json({ selected: true });
  }
  if (p === "/api/vehicle/changes" && r.method === "GET") {
    const stored = await store.getMany(["previous_summary", "summary"]);
    const previous: Observation | null = stored.previous_summary,
      current: Observation | null = stored.summary;
    if (!previous || !current)
      throw new AppError("two_observations_required", 409);
    const changes: Record<string, unknown> = {};
    for (const section of [
      "vehicle",
      "battery",
      "charging",
      "climate",
      "location",
      "closures",
      "tires",
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
  }
  const match = p.match(
    /^\/api\/vehicle(?:\/(battery|charging|location|climate|summary|readiness|tires|closures))?$/,
  );
  if (match && r.method === "GET") {
    const field = match[1] ?? "vehicle";
    if (field === "location" && e.ENABLE_LOCATION !== "true")
      throw new AppError("location_not_enabled", 403);
    let summary = await currentSummary(e, store, client);
    summary = restrictLocation(
      summary,
      e.ENABLE_LOCATION === "true",
    ) as typeof summary;
    if (field === "summary") return json(summary);
    if (field === "readiness") return json(readiness(summary));
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
