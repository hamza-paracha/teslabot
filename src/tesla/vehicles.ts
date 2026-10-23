import { AppError } from "../types";
import { Store } from "../storage/database";
import { hash } from "../security/crypto";
import { TeslaClient, type Vehicle } from "./client";
import { recovery } from "../routes/recovery";
import type { Tokens } from "./auth";

const TTL = 300000;
export type VehicleList = { vehicles: Vehicle[]; at: number };
type Selection = { id: string; vin: string };
export const vehicleId = async (vehicle: Vehicle) =>
  (await hash(vehicle.vin)).slice(0, 24);

export function clearVehicleData(store: Store) {
  return store.env.DB.prepare(
    "DELETE FROM records WHERE key IN (?,?,?,?,?)",
  ).bind(
    "selected",
    "summary",
    "previous_summary",
    "observation_history",
    "vehicles",
  );
}

// A status read uses stored metadata only; it never contacts or wakes a vehicle.
export async function vehicleAccess(store: Store) {
  const [list, selected] = await Promise.all([
    store.get<VehicleList>("vehicles"),
    store.get<Selection>("selected"),
  ]);
  const vehicles = await Promise.all(
    (list?.vehicles ?? []).map(async (v) => ({
      id: await vehicleId(v),
      display_name: v.display_name ?? null,
      state: v.state,
    })),
  );
  const state =
    list?.vehicles.length === 0
      ? "no_authorized_vehicles"
      : selected
        ? "ready"
        : list
          ? "selection_required"
          : "not_checked";
  const code =
    state === "no_authorized_vehicles" ? state : "select_vehicle_first";
  return {
    status: state,
    vehicles,
    selected_id: selected?.id ?? null,
    ...(state === "ready"
      ? {}
      : { guidance: { code, ...recovery(code, store.env.APP_ORIGIN) } }),
    data: {
      observed_at: list ? new Date(list.at).toISOString() : null,
      is_stale: !list || Date.now() - list.at >= TTL,
      may_incur_api_charges: false,
      already_awake: null,
    },
  };
}

// Call with the vehicle lock held so old-account discoveries cannot overwrite a reconnect.
export async function discoverVehicles(store: Store, refresh: boolean) {
  const previous = await store.get<VehicleList>("vehicles");
  const cacheHit = !refresh && !!previous && Date.now() - previous.at < TTL;
  if (!cacheHit) {
    const list = await new TeslaClient(store).vehicles();
    const selected = await store.get<Selection>("selected");
    const ids = await Promise.all(list.map(vehicleId));
    await store.putMany(
      { vehicles: { vehicles: list, at: Date.now() } },
      selected && !ids.includes(selected.id)
        ? [
            store.env.DB.prepare(
              "DELETE FROM records WHERE key IN (?,?,?,?)",
            ).bind(
              "selected",
              "summary",
              "previous_summary",
              "observation_history",
            ),
          ]
        : [],
    );
  }
  const result = await vehicleAccess(store);
  return { ...result, data: { ...result.data, cache_hit: cacheHit } };
}

export async function selectionRequired(store: Store): Promise<never> {
  const tokens = await store.get<Tokens>("owner_tokens");
  if (!tokens) throw new AppError("tesla_not_connected", 409);
  if (
    tokens.scope !== undefined &&
    !tokens.scope.split(/\s+/).includes("vehicle_device_data")
  )
    throw new AppError("missing_vehicle_data_scope", 403);
  const list = await store.get<VehicleList>("vehicles");
  throw new AppError(
    list && Date.now() - list.at < TTL && !list.vehicles.length
      ? "no_authorized_vehicles"
      : "select_vehicle_first",
    409,
  );
}
