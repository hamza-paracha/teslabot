import type { Env } from "../types";
import { AppError } from "../types";
import { Store } from "../storage/database";
import { random } from "../security/crypto";
import { json, readJson } from "./http";
import { currentSummary } from "./vehicle";
import type { Observation } from "../context/observations";
import {
  assessTrip,
  mergeTrip,
  OUTCOME_LIMIT,
  outcomeSchema,
  recordOutcome,
  TRIP_LIMIT,
  TRIP_RETENTION_MS,
  tripPlanSchema,
  type StoredTrip,
  type TripOutcome,
} from "../context/trip";

export type TripStore = { trips: StoredTrip[]; outcomes: TripOutcome[] };

const newTripId = () => random().replace(/-/g, "").slice(0, 24);

// A missing battery reading must not prevent saving the plan itself.
async function observationOrNull(e: Env, store: Store) {
  try {
    return await currentSummary(e, store);
  } catch (error) {
    if (error instanceof AppError && error.code !== "operation_in_progress")
      return { error: error.code };
    throw error;
  }
}

export async function tripRoute(
  r: Request,
  e: Env,
  store: Store,
): Promise<Response | null> {
  const p = new URL(r.url).pathname;
  if (p === "/api/trips" && r.method === "GET") {
    const { trips, selected } = await store.getMany(["trips", "selected"]);
    const saved: TripStore = trips ?? { trips: [], outcomes: [] };
    return json({
      trips: saved.trips
        .filter((trip) => trip.vehicle_id === selected?.id)
        .map(({ vehicle_id: _vehicle, ...trip }) => trip),
      outcomes: saved.outcomes
        .filter((item) => item.vehicle_id === selected?.id)
        .map(({ vehicle_id: _vehicle, ...item }) => item),
    });
  }
  if (p === "/api/trips" && r.method === "POST") {
    const parsed = tripPlanSchema.safeParse(await readJson(r, 8192));
    if (!parsed.success) throw new AppError("invalid_trip_plan");
    // Skip the Tesla read entirely until there is a route to assess.
    const peek: TripStore | null = await store.get("trips");
    const hasRoute =
      !!parsed.data.legs?.length ||
      (parsed.data.legs === undefined &&
        !!peek?.trips.find((trip) => trip.id === parsed.data.trip_id)?.legs
          .length);
    const reading = hasRoute ? await observationOrNull(e, store) : null;
    const observation = reading && !("error" in reading) ? reading : null;
    return store.locked(
      "trips",
      async () => {
        const stored = await store.getMany(["trips", "selected"]);
        const selected: { id: string } | null = stored.selected;
        if (!selected) throw new AppError("select_vehicle_first", 409);
        const saved: TripStore = stored.trips ?? { trips: [], outcomes: [] };
        const live = saved.trips.filter(
          (trip) =>
            trip.vehicle_id === selected.id &&
            Date.parse(trip.updated_at) >= Date.now() - TRIP_RETENTION_MS,
        );
        const previous = parsed.data.trip_id
          ? live.find((trip) => trip.id === parsed.data.trip_id)
          : null;
        if (parsed.data.trip_id && !previous)
          throw new AppError("trip_not_found", 404);
        const merged = mergeTrip(
          previous ?? null,
          parsed.data,
          previous?.id ?? newTripId(),
          selected.id,
        );
        const outcomes = saved.outcomes.filter(
          (item) => item.vehicle_id === selected.id,
        );
        const result = assessTrip(
          merged,
          observation?.vehicle.id === selected.id ? observation : null,
          outcomes,
        );
        if (result.start_percentage !== null) {
          merged.assessed_start_percentage = result.start_percentage;
          merged.assessed_used_percentage =
            result.rated_battery_used_percentage;
        }
        await store.put("trips", {
          trips: [...live.filter((trip) => trip.id !== merged.id), merged]
            .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at))
            .slice(-TRIP_LIMIT),
          outcomes: outcomes.slice(-OUTCOME_LIMIT),
        } satisfies TripStore);
        return json({
          ...result,
          ...(reading && "error" in reading
            ? { vehicle_data_error: reading.error }
            : {}),
        });
      },
      10000,
    );
  }
  if (p === "/api/trips/outcome" && r.method === "POST") {
    const parsed = outcomeSchema.safeParse(await readJson(r));
    if (!parsed.success) throw new AppError("invalid_trip_outcome");
    const reading =
      parsed.data.actual_end_percentage === undefined
        ? await observationOrNull(e, store)
        : null;
    return store.locked(
      "trips",
      async () => {
        const stored = await store.getMany(["trips", "selected"]);
        const selected: { id: string } | null = stored.selected;
        const saved: TripStore = stored.trips ?? { trips: [], outcomes: [] };
        const trip = saved.trips.find(
          (item) =>
            item.id === parsed.data.trip_id && item.vehicle_id === selected?.id,
        );
        if (!trip) throw new AppError("trip_not_found", 404);
        let outcome: TripOutcome;
        try {
          outcome = recordOutcome(
            trip,
            parsed.data,
            reading && !("error" in reading) ? (reading as Observation) : null,
          );
        } catch (error) {
          throw new AppError((error as Error).message, 409);
        }
        const outcomes = [
          ...saved.outcomes.filter(
            (item) =>
              item.vehicle_id === trip.vehicle_id &&
              !(
                item.trip_id === trip.id &&
                item.recorded_at.slice(0, 10) ===
                  outcome.recorded_at.slice(0, 10)
              ),
          ),
          outcome,
        ].slice(-OUTCOME_LIMIT);
        await store.put("trips", { ...saved, outcomes } satisfies TripStore);
        const comparable = outcomes.filter((item) => item.consumption_ratio);
        const { vehicle_id: _vehicle, ...visible } = outcome;
        return json({
          outcome: visible,
          accuracy: {
            recorded_trips: outcomes.length,
            comparable_trips: comparable.length,
            mean_absolute_error_percentage_points: outcomes.length
              ? Math.round(
                  (outcomes.reduce(
                    (sum, item) => sum + Math.abs(item.error_percentage_points),
                    0,
                  ) /
                    outcomes.length) *
                    10,
                ) / 10
              : null,
          },
          calibration: assessTrip(trip, null, outcomes).calibration,
          actions_executed: false,
        });
      },
      10000,
    );
  }
  return null;
}
