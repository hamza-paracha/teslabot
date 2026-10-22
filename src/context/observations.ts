import { z } from "zod";
import type { normalize } from "../tesla/normalization";

export type Observation = ReturnType<typeof normalize>;
export const preferencesSchema = z
  .object({
    history_enabled: z.boolean(),
    battery_change_percentage: z.number().int().min(1).max(50),
    temperature_change_c: z.number().min(1).max(20),
  })
  .strict();
export const defaultPreferences = {
  history_enabled: false,
  battery_change_percentage: 5,
  temperature_change_c: 3,
};
export type Preferences = z.infer<typeof preferencesSchema>;
export const HISTORY_LIMIT = 48;
export const HISTORY_RETENTION_MS = 7 * 86400000;

export function freshness(observedAt: string | null, now = Date.now()) {
  const time = observedAt ? Date.parse(observedAt) : NaN;
  const age = Number.isFinite(time) ? now - time : NaN;
  return {
    observed_at: observedAt,
    age_seconds:
      Number.isFinite(age) && age >= -60000
        ? Math.max(0, Math.floor(age / 1000))
        : null,
    is_stale: !Number.isFinite(age) || age < -60000 || age > 300000,
  };
}

export function refreshObservation(
  current: Observation,
  now = Date.now(),
): Observation {
  const sections = Object.fromEntries(
    Object.entries(current.data.sections ?? {}).map(([name, section]) => [
      name,
      freshness(section.observed_at, now),
    ]),
  ) as Observation["data"]["sections"];
  return {
    ...current,
    data: {
      ...current.data,
      ...freshness(current.data.observed_at, now),
      sections,
      is_stale:
        current.data.is_stale ||
        freshness(current.data.observed_at, now).is_stale,
    },
  };
}

export function restrictLocation(
  current: Observation,
  enabled: boolean,
): Observation {
  if (enabled) return current;
  const { location: _location, ...observation } = current;
  const { location: _timestamp, ...sections } = current.data.sections ?? {};
  return { ...observation, data: { ...current.data, sections } };
}

export function appendHistory(
  history: Observation[],
  next: Observation,
  now = Date.now(),
) {
  // One observation per source timestamp; cache hits never create history.
  const matching = history.filter(
    (item) =>
      item.vehicle.id === next.vehicle.id &&
      Date.parse(item.data.retrieved_at) >= now - HISTORY_RETENTION_MS,
  );
  if (
    next.data.observed_at &&
    !matching.some((item) => item.data.observed_at === next.data.observed_at)
  )
    matching.push(next);
  return matching.slice(-HISTORY_LIMIT);
}

export function describeChanges(
  previous: Observation | null,
  current: Observation,
  preferences: Preferences,
) {
  if (!previous || previous.vehicle.id !== current.vehicle.id) return [];
  const interval = {
    from: previous.data.observed_at,
    to: current.data.observed_at,
  };
  if (
    !interval.from ||
    !interval.to ||
    Date.parse(interval.to) <= Date.parse(interval.from)
  )
    return [];
  const changes: Array<{
    kind: string;
    message: string;
    interval: typeof interval;
  }> = [];
  const add = (kind: string, message: string) =>
    changes.push({ kind, message, interval });
  const before = previous.battery.percentage,
    after = current.battery.percentage;
  if (
    before !== null &&
    after !== null &&
    Math.abs(after - before) >= preferences.battery_change_percentage
  )
    add("battery", `Battery changed from ${before}% to ${after}%.`);
  if (
    previous.charging.state &&
    current.charging.state &&
    previous.charging.state !== current.charging.state
  )
    add(
      "charging",
      `Charging state changed from ${previous.charging.state} to ${current.charging.state} between observations; the exact transition time is unknown.`,
    );
  if (
    previous.vehicle.locked !== null &&
    current.vehicle.locked !== null &&
    previous.vehicle.locked !== current.vehicle.locked
  )
    add(
      "lock",
      `The latest observation reports the vehicle ${current.vehicle.locked ? "locked" : "unlocked"}.`,
    );
  const oldTemp = previous.climate.interior_c,
    temp = current.climate.interior_c;
  if (
    oldTemp !== null &&
    temp !== null &&
    Math.abs(temp - oldTemp) >= preferences.temperature_change_c
  )
    add("climate", `Cabin temperature changed from ${oldTemp}°C to ${temp}°C.`);
  return changes;
}

export function buildContext(
  current: Observation,
  previous: Observation | null,
  preferences: Preferences,
) {
  current = refreshObservation(current);
  const state = freshness(current.data.observed_at);
  const stale = current.data.is_stale || state.is_stale;
  const label = stale ? "Last known" : "Latest observed";
  const facts: string[] = [];
  if (current.battery.percentage !== null)
    facts.push(`${label} battery is ${current.battery.percentage}%.`);
  if (current.battery.range_km !== null)
    facts.push(
      `Tesla's estimated range is ${Math.round(current.battery.range_km)} km.`,
    );
  if (current.charging.state)
    facts.push(`Charging state: ${current.charging.state}.`);
  if (current.climate.interior_c !== null)
    facts.push(`Cabin temperature is ${current.climate.interior_c}°C.`);
  if (current.climate.exterior_c !== null)
    facts.push(`Outside temperature is ${current.climate.exterior_c}°C.`);
  return {
    vehicle: current.vehicle,
    narrative: facts.length
      ? facts.join(" ")
      : "No supported vehicle readings are available in this observation.",
    changes: describeChanges(previous, current, preferences),
    limitations: [
      ...(stale
        ? [
            "This is historical data; do not describe it as the vehicle's current state.",
          ]
        : []),
      "Vehicle connectivity was checked at retrieval time; current connectivity may differ.",
      "No trip history, driving efficiency, calendar, traffic or charging routine has been inferred.",
      "Changes are observed between samples; exact event times are unknown.",
    ],
    observation: current,
    data: { ...current.data, ...state, is_stale: stale },
  };
}

export const tripSchema = z
  .object({
    distance_km: z.number().positive().max(5000),
    reserve_percentage: z.number().min(5).max(50).default(20),
  })
  .strict();

export function estimateTrip(
  current: Observation,
  input: z.infer<typeof tripSchema>,
  now = Date.now(),
) {
  current = refreshObservation(current, now);
  const observed = freshness(current.data.observed_at, now);
  const battery = current.battery.percentage,
    range = current.battery.range_km;
  const usable =
    current.data.sections?.battery?.is_stale === false &&
    !current.data.is_stale &&
    !observed.is_stale &&
    battery !== null &&
    battery > 0 &&
    range !== null &&
    range > 0;
  const arrival = usable ? battery * (1 - input.distance_km / range) : null;
  return {
    vehicle: { id: current.vehicle.id },
    assessment:
      arrival === null
        ? "insufficient_fresh_data"
        : arrival >= input.reserve_percentage
          ? "within_reported_range_estimate"
          : "charging_recommended",
    distance_km: input.distance_km,
    reserve_percentage: input.reserve_percentage,
    estimated_arrival_percentage:
      arrival === null || arrival < 0 ? null : Math.round(arrival * 10) / 10,
    reported_range_shortfall_km: usable
      ? Math.round(Math.max(0, input.distance_km - range!) * 10) / 10
      : null,
    assumptions: [
      "Distance is supplied by the caller and must include every leg of the trip.",
      "Uses Tesla's reported range with a linear battery-to-distance estimate; it does not use recorded driving efficiency.",
    ],
    limitations: [
      "This is not a guarantee of reachability. Weather, speed, elevation, battery temperature and detours can change consumption.",
      "No map, route, traffic, calendar or charger availability service is connected.",
    ],
    data: {
      ...current.data,
      ...observed,
      is_stale: current.data.is_stale || observed.is_stale,
    },
  };
}
