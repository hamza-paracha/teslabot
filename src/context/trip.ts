import { z } from "zod";
import {
  freshness,
  refreshObservation,
  type Observation,
} from "./observations";

export const TRIP_LIMIT = 20;
export const OUTCOME_LIMIT = 50;
export const TRIP_RETENTION_MS = 30 * 86400000;
const CALIBRATION_MIN_OUTCOMES = 3;

const label = z.string().trim().min(1).max(200);
const chargingSchema = z
  .object({
    usable_capacity_kwh: z.number().positive().max(250),
    charger_power_kw: z.number().positive().max(500),
    available_minutes: z.number().int().min(1).max(1440).optional(),
    charging_efficiency: z.number().min(0.5).max(1).default(0.9),
  })
  .strict();

// Every field except trip_id is optional on follow-ups: omitted fields keep their
// previous value, null clears an optional one, and `legs` replaces the whole route.
export const tripPlanSchema = z
  .object({
    trip_id: z
      .string()
      .regex(/^[a-f0-9]{24}$/)
      .optional(),
    destination: label.optional(),
    origin: label.optional(),
    route_source: z.string().trim().min(1).max(120).optional(),
    legs: z
      .array(
        z
          .object({ to: label, distance_km: z.number().positive().max(2500) })
          .strict(),
      )
      .min(1)
      .max(10)
      .optional(),
    return_distance_km: z.number().positive().max(2500).nullable().optional(),
    reserve_percentage: z.number().min(5).max(50).optional(),
    charging: chargingSchema.nullable().optional(),
  })
  .strict();
export type TripPlanInput = z.infer<typeof tripPlanSchema>;

export interface StoredTrip {
  id: string;
  vehicle_id: string;
  revision: number;
  created_at: string;
  updated_at: string;
  destination: string | null;
  origin: string | null;
  route_source: string | null;
  legs: Array<{ to: string; distance_km: number }>;
  return_distance_km: number | null;
  reserve_percentage: number;
  charging: z.infer<typeof chargingSchema> | null;
  // Battery and predicted use when the plan was last assessed; used for outcomes.
  assessed_start_percentage: number | null;
  assessed_used_percentage: number | null;
}

export const outcomeSchema = z
  .object({
    trip_id: z.string().regex(/^[a-f0-9]{24}$/),
    actual_end_percentage: z.number().min(0).max(100).optional(),
    start_percentage: z.number().min(0).max(100).optional(),
    charged_during_trip: z.boolean().default(false),
  })
  .strict();

export interface TripOutcome {
  trip_id: string;
  vehicle_id: string;
  recorded_at: string;
  distance_km: number;
  start_percentage: number;
  actual_end_percentage: number;
  predicted_used_percentage: number;
  actual_used_percentage: number;
  error_percentage_points: number;
  consumption_ratio: number | null;
  charged_during_trip: boolean;
  end_source: "supplied_by_caller" | "fresh_vehicle_reading";
}

export function mergeTrip(
  previous: StoredTrip | null,
  input: TripPlanInput,
  id: string,
  vehicleId: string,
  now = Date.now(),
): StoredTrip {
  const at = new Date(now).toISOString();
  const pick = <K extends keyof TripPlanInput & keyof StoredTrip>(
    key: K,
    fallback: StoredTrip[K],
  ) =>
    (input[key] === undefined
      ? (previous?.[key] ?? fallback)
      : input[key]) as StoredTrip[K];
  return {
    id,
    vehicle_id: vehicleId,
    revision: (previous?.revision ?? 0) + 1,
    created_at: previous?.created_at ?? at,
    updated_at: at,
    destination: pick("destination", null),
    origin: pick("origin", null),
    route_source: pick("route_source", null),
    legs: pick("legs", []),
    return_distance_km: pick("return_distance_km", null),
    reserve_percentage: pick("reserve_percentage", 20),
    charging: pick("charging", null),
    assessed_start_percentage: previous?.assessed_start_percentage ?? null,
    assessed_used_percentage: previous?.assessed_used_percentage ?? null,
  };
}

// Median ratio of actual to predicted battery use over comparable past trips.
export function calibration(outcomes: TripOutcome[]) {
  const ratios = outcomes
    .filter((item) => !item.charged_during_trip && item.consumption_ratio)
    .map((item) => item.consumption_ratio!)
    .sort((a, b) => a - b);
  const median = ratios.length
    ? ratios.length % 2
      ? ratios[(ratios.length - 1) / 2]
      : (ratios[ratios.length / 2 - 1] + ratios[ratios.length / 2]) / 2
    : null;
  const ready = median !== null && ratios.length >= CALIBRATION_MIN_OUTCOMES;
  return {
    comparable_trips: ratios.length,
    learned_consumption_ratio: median === null ? null : round(median, 3),
    // Only ever make the estimate more conservative than Tesla's reported range.
    applied_factor: ready ? round(Math.min(2, Math.max(1, median)), 3) : 1,
    status: ready
      ? "applied"
      : `needs_${CALIBRATION_MIN_OUTCOMES}_comparable_trips`,
  };
}

const round = (value: number, places = 1) =>
  Math.round(value * 10 ** places) / 10 ** places;

export function assessTrip(
  trip: StoredTrip,
  observation: Observation | null,
  outcomes: TripOutcome[] = [],
  now = Date.now(),
) {
  const legs = [
    ...trip.legs,
    ...(trip.return_distance_km
      ? [
          {
            to: trip.origin ? `Return to ${trip.origin}` : "Return to origin",
            distance_km: trip.return_distance_km,
          },
        ]
      : []),
  ];
  const total = legs.reduce((sum, leg) => sum + leg.distance_km, 0);
  const current = observation ? refreshObservation(observation, now) : null;
  const observed = freshness(current?.data.observed_at ?? null, now);
  const battery = current?.battery.percentage ?? null,
    range = current?.battery.range_km ?? null;
  const fresh =
    !!current &&
    current.data.sections?.battery?.is_stale === false &&
    !current.data.is_stale &&
    !observed.is_stale &&
    battery !== null &&
    battery > 0 &&
    range !== null &&
    range > 0;
  const calibrated = calibration(
    outcomes.filter((item) => item.vehicle_id === trip.vehicle_id),
  );
  const perKm = fresh ? (battery! / range!) * calibrated.applied_factor : null;
  let cumulative = 0;
  const legResults = legs.map((leg) => {
    cumulative += leg.distance_km;
    const arrival = perKm === null ? null : battery! - cumulative * perKm;
    return {
      to: leg.to,
      distance_km: leg.distance_km,
      cumulative_km: round(cumulative),
      estimated_arrival_percentage:
        arrival === null ? null : round(Math.max(0, arrival)),
      below_reserve:
        arrival === null ? null : arrival < trip.reserve_percentage,
      beyond_reported_range: arrival === null ? null : arrival < 0,
    };
  });
  const used = perKm === null ? null : total * perKm;
  const final = used === null ? null : battery! - used;
  const required = used === null ? null : trip.reserve_percentage + used;
  const shortfall = required === null ? null : Math.max(0, required - battery!);
  const limit = current?.charging.limit_percentage ?? null;
  const assessment = !legs.length
    ? "route_required"
    : !fresh
      ? "insufficient_fresh_data"
      : shortfall === 0
        ? "within_reserve"
        : required! > 100
          ? "exceeds_single_charge"
          : "charging_recommended";
  const charging = trip.charging && fresh ? chargingAdvice() : null;
  function chargingAdvice() {
    const c = trip.charging!;
    const percentPerMinute =
      (c.charger_power_kw * c.charging_efficiency * 100) /
      c.usable_capacity_kwh /
      60;
    const ceiling = Math.min(100, Math.max(limit ?? 100, battery!));
    const minutesNeeded =
      shortfall! > 0 && required! <= 100
        ? Math.ceil(shortfall! / percentPerMinute)
        : shortfall === 0
          ? 0
          : null;
    const window = c.available_minutes
      ? (() => {
          const gained = Math.min(
            ceiling - battery!,
            c.available_minutes * percentPerMinute,
          );
          const after = final! + gained;
          return {
            available_minutes: c.available_minutes,
            estimated_percentage_gained: round(gained),
            estimated_departure_percentage: round(battery! + gained),
            estimated_final_percentage: round(after),
            estimated_extra_range_km: round(gained / perKm!),
            meets_reserve: after >= trip.reserve_percentage,
            limited_by_charge_limit:
              c.available_minutes * percentPerMinute > ceiling - battery!,
          };
        })()
      : null;
    return {
      charger_power_kw: c.charger_power_kw,
      usable_capacity_kwh: c.usable_capacity_kwh,
      charging_efficiency: c.charging_efficiency,
      estimated_percentage_per_hour: round(percentPerMinute * 60),
      minutes_needed_for_reserve: minutesNeeded,
      charge_limit_percentage: limit,
      charge_limit_must_be_raised:
        limit !== null && required !== null && required > limit,
      window,
    };
  }
  return {
    trip_id: trip.id,
    revision: trip.revision,
    destination: trip.destination,
    origin: trip.origin,
    route_source: trip.route_source,
    legs: legResults,
    total_distance_km: round(total),
    reserve_percentage: trip.reserve_percentage,
    assessment,
    start_percentage: fresh ? battery : null,
    estimated_final_percentage:
      final === null ? null : round(Math.max(0, final)),
    estimated_battery_used_percentage: used === null ? null : round(used),
    rated_battery_used_percentage:
      perKm === null ? null : round((total * battery!) / range!, 2),
    minimum_departure_percentage: required === null ? null : round(required),
    shortfall_percentage: shortfall === null ? null : round(shortfall),
    charging,
    calibration: calibrated,
    missing_context: [
      ...(!legs.length
        ? [
            "Supply ordered legs with driving distances from the host's authorized routing tool. A place name alone is not a distance.",
          ]
        : []),
      ...(!fresh && legs.length
        ? [
            "A fresh battery reading with Tesla's range estimate is required; the car may be asleep. No assessment was made.",
          ]
        : []),
      ...(fresh && shortfall! > 0 && !trip.charging
        ? [
            "Supply usable battery capacity and charger power to estimate how long to charge.",
          ]
        : []),
    ],
    assumptions: [
      "Battery use is linear in Tesla's reported range" +
        (calibrated.applied_factor > 1
          ? `, increased by a learned factor of ${calibrated.applied_factor} from this car's recorded trips.`
          : "."),
      "Leg distances come from the caller's routing source; no charging between legs.",
      ...(trip.charging
        ? [
            "Charging assumes constant power at the stated efficiency; tapering near the charge limit and cold batteries can make it slower.",
          ]
        : []),
    ],
    limitations: [
      "This is an estimate, not a reachability guarantee. Weather, speed, elevation, cabin heating and detours change consumption.",
      "Planning only: no destination is sent to the car and no charging is started.",
    ],
    actions_executed: false,
    data: current
      ? { ...current.data, ...observed, is_stale: !fresh }
      : { observed_at: null, is_stale: true },
  };
}

export function recordOutcome(
  trip: StoredTrip,
  input: z.infer<typeof outcomeSchema>,
  observation: Observation | null,
  now = Date.now(),
): TripOutcome {
  const start = input.start_percentage ?? trip.assessed_start_percentage;
  if (start === null || trip.assessed_used_percentage === null)
    throw new Error("trip_not_assessed");
  let end = input.actual_end_percentage ?? null;
  let source: TripOutcome["end_source"] = "supplied_by_caller";
  if (end === null) {
    const current = observation ? refreshObservation(observation, now) : null;
    if (
      !current ||
      current.data.is_stale ||
      current.data.sections?.battery?.is_stale !== false ||
      current.battery.percentage === null
    )
      throw new Error("fresh_battery_reading_required");
    end = current.battery.percentage;
    source = "fresh_vehicle_reading";
  }
  const distance =
    trip.legs.reduce((sum, leg) => sum + leg.distance_km, 0) +
    (trip.return_distance_km ?? 0);
  const actual = start - end;
  // Rated (uncalibrated) prediction, so the ratio does not compound earlier corrections.
  const predicted = trip.assessed_used_percentage;
  return {
    trip_id: trip.id,
    vehicle_id: trip.vehicle_id,
    recorded_at: new Date(now).toISOString(),
    distance_km: round(distance),
    start_percentage: start,
    actual_end_percentage: end,
    predicted_used_percentage: round(predicted),
    actual_used_percentage: round(actual),
    error_percentage_points: round(actual - predicted),
    consumption_ratio:
      predicted >= 3 && actual > 0 && !input.charged_during_trip
        ? round(actual / predicted, 3)
        : null,
    charged_during_trip: input.charged_during_trip,
    end_source: source,
  };
}
