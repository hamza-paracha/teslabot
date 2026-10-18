import { z } from "zod";
import { AppError } from "../types";
import { freshness } from "../context/observations";
const n = z.number().finite().nullable().optional(),
  b = z.boolean().nullable().optional(),
  s = z.string().nullable().optional();
export const dataSchema = z.object({
  charge_state: z
    .object({
      battery_level: z.number().min(0).max(100).nullable().optional(),
      battery_range: z.number().nonnegative().nullable().optional(),
      charging_state: s,
      charger_power: n,
      charge_limit_soc: n,
      charge_port_latch: s,
      time_to_full_charge: n,
      timestamp: n,
    })
    .optional(),
  climate_state: z
    .object({ inside_temp: n, outside_temp: n, is_climate_on: b, timestamp: n })
    .optional(),
  vehicle_state: z
    .object({
      locked: b,
      odometer: n,
      sentry_mode: b,
      car_version: s,
      timestamp: n,
    })
    .optional(),
  drive_state: z.object({ latitude: n, longitude: n, timestamp: n }).optional(),
});
export function normalize(
  raw: unknown,
  id: string,
  name: string | null | undefined,
  location: boolean,
) {
  const p = dataSchema.safeParse(raw);
  if (!p.success || !Object.keys(p.data).length)
    throw new AppError("unexpected_tesla_response", 502);
  const d = p.data,
    c = d.charge_state,
    a = d.climate_state,
    v = d.vehicle_state,
    l = d.drive_state;
  const dates = [
    c?.timestamp,
    a?.timestamp,
    v?.timestamp,
    ...(location ? [l?.timestamp] : []),
  ].filter(
    (x): x is number =>
      typeof x === "number" && x > 0 && x <= Date.now() + 60000,
  );
  const timestamp = dates.length ? Math.min(...dates) : null;
  const sectionTime = (time: number | null | undefined) =>
    freshness(
      typeof time === "number" && time > 0 && time <= Date.now() + 60000
        ? new Date(time).toISOString()
        : null,
    );
  const sections = {
    battery: sectionTime(c?.timestamp),
    charging: sectionTime(c?.timestamp),
    climate: sectionTime(a?.timestamp),
    vehicle: sectionTime(v?.timestamp),
    ...(location ? { location: sectionTime(l?.timestamp) } : {}),
  };
  return {
    vehicle: {
      id,
      display_name: name ?? null,
      online: true,
      locked: v?.locked ?? null,
      odometer_km: v?.odometer == null ? null : v.odometer * 1.609344,
      sentry_mode: v?.sentry_mode ?? null,
      software_version: v?.car_version ?? null,
    },
    battery: {
      percentage: c?.battery_level ?? null,
      range_km: c?.battery_range == null ? null : c.battery_range * 1.609344,
    },
    charging: {
      state: c?.charging_state ?? null,
      charging:
        c?.charging_state == null ? null : c.charging_state === "Charging",
      connected:
        c?.charging_state == null || c.charging_state === "Unknown"
          ? null
          : !["Disconnected", "Unknown"].includes(c.charging_state),
      power_kw: c?.charger_power ?? null,
      limit_percentage: c?.charge_limit_soc ?? null,
      hours_remaining: c?.time_to_full_charge ?? null,
    },
    climate: {
      interior_c: a?.inside_temp ?? null,
      exterior_c: a?.outside_temp ?? null,
      enabled: a?.is_climate_on ?? null,
    },
    ...(location
      ? {
          location: {
            latitude: l?.latitude ?? null,
            longitude: l?.longitude ?? null,
            observed_at: sections.location?.observed_at ?? null,
          },
        }
      : {}),
    data: {
      observed_at: timestamp ? new Date(timestamp).toISOString() : null,
      retrieved_at: new Date().toISOString(),
      is_stale:
        timestamp === null ||
        Date.now() - timestamp > 300000 ||
        (c !== undefined && sections.battery.is_stale) ||
        (a !== undefined && sections.climate.is_stale) ||
        (v !== undefined && sections.vehicle.is_stale) ||
        (location && sections.location!.is_stale),
      source: "tesla_fleet_api",
      sections,
      already_awake: true as boolean | null,
      may_incur_api_charges: true,
      unavailable_fields_are_null: true,
    },
  };
}
