import type { Env } from "../types";
import { AppError } from "../types";
import { Store } from "../storage/database";
import { hash } from "../security/crypto";
import { TeslaClient, type Vehicle } from "../tesla/client";
import { normalize } from "../tesla/normalization";
import { json, readJson } from "./http";

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
        const old = previous[section],
          now = current[section];
        if (JSON.stringify(old) !== JSON.stringify(now))
          changes[section] = { before: old ?? null, after: now ?? null };
      }
      return json({
        vehicle: current.vehicle,
        changes,
        previous_observed_at: previous.data.observed_at,
        data: current.data,
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
    const summary = await store.locked("vehicle", async () => {
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
            ...cached.data,
            is_stale:
              cached.data.observed_at === null ||
              Date.now() - Date.parse(cached.data.observed_at) > 300000,
            cache_hit: true,
            may_incur_api_charges: false,
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
        if (cached) await store.put("previous_summary", cached);
        await store.put("summary", result);
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
