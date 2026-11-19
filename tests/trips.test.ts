import { describe, it, expect, vi } from "vitest";
import { normalize } from "../src/tesla/normalization";
import {
  assessTrip,
  calibration,
  mergeTrip,
  recordOutcome,
  type TripOutcome,
} from "../src/context/trip";
import { e, store, vin, req } from "./helpers/app";

const id = "a".repeat(24);
// 46% with 230 km of reported range: 0.2% of battery per km.
const reading = (battery = 46, rangeKm = 230, at = Date.now()) =>
  normalize(
    {
      charge_state: {
        battery_level: battery,
        battery_range: rangeKm / 1.609344,
        charging_state: "Disconnected",
        charge_limit_soc: 80,
        timestamp: at,
      },
      climate_state: { inside_temp: 18, timestamp: at },
      vehicle_state: { locked: true, timestamp: at },
    },
    id,
    "Car",
    false,
  );
const plan = (input: Parameters<typeof mergeTrip>[1]) =>
  mergeTrip(null, input, "b".repeat(24), id);
const mcp = (path: string, body?: unknown) =>
  req(path, {
    headers: {
      Authorization: "Bearer " + e.MCP_TOKEN,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });

describe("trip math", () => {
  it("works backward from the reserve and prices a charging window", () => {
    const result = assessTrip(
      plan({
        origin: "Home",
        legs: [{ to: "Mississauga", distance_km: 80 }],
        return_distance_km: 80,
        reserve_percentage: 20,
        charging: {
          usable_capacity_kwh: 75,
          charger_power_kw: 7.2,
          available_minutes: 30,
          charging_efficiency: 0.9,
        },
      }),
      reading(),
    );
    expect(result.assessment).toBe("charging_recommended");
    expect(result.legs.map((leg) => leg.estimated_arrival_percentage)).toEqual([
      30, 14,
    ]);
    expect(result.legs[1].to).toBe("Return to Home");
    expect(result.estimated_final_percentage).toBe(14);
    expect(result.minimum_departure_percentage).toBe(52);
    expect(result.shortfall_percentage).toBe(6);
    expect(result.charging).toMatchObject({
      estimated_percentage_per_hour: 8.6,
      minutes_needed_for_reserve: 42,
      charge_limit_must_be_raised: false,
      window: {
        available_minutes: 30,
        estimated_percentage_gained: 4.3,
        estimated_final_percentage: 18.3,
        estimated_extra_range_km: 21.6,
        meets_reserve: false,
      },
    });
    expect(result.actions_executed).toBe(false);
  });
  it("flags a plan that cannot be done on one charge or needs a higher limit", () => {
    const far = assessTrip(
      plan({ legs: [{ to: "Far", distance_km: 500 }] }),
      reading(),
    );
    expect(far.assessment).toBe("exceeds_single_charge");
    expect(far.legs[0].beyond_reported_range).toBe(true);
    expect(far.estimated_final_percentage).toBe(0);
    const limited = assessTrip(
      plan({
        legs: [{ to: "A", distance_km: 150 }],
        reserve_percentage: 20,
        charging: {
          usable_capacity_kwh: 75,
          charger_power_kw: 11,
          charging_efficiency: 0.9,
        },
      }),
      reading(),
    );
    expect(limited.minimum_departure_percentage).toBe(50);
    expect(limited.charging?.charge_limit_must_be_raised).toBe(false);
    const high = assessTrip(
      plan({
        legs: [{ to: "B", distance_km: 350 }],
        charging: {
          usable_capacity_kwh: 75,
          charger_power_kw: 11,
          charging_efficiency: 0.9,
        },
      }),
      reading(),
    );
    expect(high.minimum_departure_percentage).toBe(90);
    expect(high.charging?.charge_limit_must_be_raised).toBe(true);
  });
  it("refuses an assessment from stale data or a missing route", () => {
    expect(
      assessTrip(
        plan({ legs: [{ to: "A", distance_km: 10 }] }),
        reading(46, 230, Date.now() - 3600000),
      ),
    ).toMatchObject({
      assessment: "insufficient_fresh_data",
      start_percentage: null,
      estimated_final_percentage: null,
    });
    expect(
      assessTrip(plan({ destination: "Airport" }), reading()),
    ).toMatchObject({ assessment: "route_required", legs: [] });
  });
  it("keeps prior fields on follow-ups, replaces legs and clears with null", () => {
    const first = plan({
      destination: "Cottage",
      legs: [{ to: "Cottage", distance_km: 80 }],
      return_distance_km: 80,
      reserve_percentage: 25,
    });
    const second = mergeTrip(
      first,
      {
        legs: [
          { to: "Mississauga", distance_km: 30 },
          { to: "Cottage", distance_km: 60 },
        ],
      },
      first.id,
      id,
    );
    expect(second).toMatchObject({
      revision: 2,
      destination: "Cottage",
      reserve_percentage: 25,
      return_distance_km: 80,
    });
    expect(second.legs).toHaveLength(2);
    expect(
      mergeTrip(second, { return_distance_km: null }, first.id, id)
        .return_distance_km,
    ).toBeNull();
  });
  it("learns only a conservative consumption factor from comparable trips", () => {
    const outcome = (ratio: number | null, charged = false) =>
      ({
        vehicle_id: id,
        consumption_ratio: ratio,
        charged_during_trip: charged,
      }) as TripOutcome;
    expect(calibration([outcome(1.3), outcome(1.2)])).toMatchObject({
      applied_factor: 1,
      status: "needs_3_comparable_trips",
    });
    expect(
      calibration([outcome(1.3), outcome(1.1), outcome(1.2), outcome(3, true)]),
    ).toMatchObject({ applied_factor: 1.2, comparable_trips: 3 });
    expect(
      calibration([outcome(0.8), outcome(0.9), outcome(0.85)]).applied_factor,
    ).toBe(1);
    const trip = {
      ...plan({ legs: [{ to: "A", distance_km: 100 }] }),
      assessed_start_percentage: 80,
      assessed_used_percentage: 20,
    };
    expect(
      recordOutcome(
        trip,
        {
          trip_id: trip.id,
          actual_end_percentage: 55,
          charged_during_trip: false,
        },
        null,
      ),
    ).toMatchObject({
      actual_used_percentage: 25,
      error_percentage_points: 5,
      consumption_ratio: 1.25,
      end_source: "supplied_by_caller",
    });
  });
});

describe("trip routes", () => {
  it("saves a trip, answers follow-ups by id, and never calls Tesla on a cache hit", async () => {
    await store.putMany({ selected: { id, vin }, summary: reading() });
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const first = (await (
      await mcp("/api/trips", {
        destination: "Cottage",
        origin: "Home",
        route_source: "fixture-maps",
        legs: [{ to: "Cottage", distance_km: 80 }],
        return_distance_km: 80,
      })
    ).json()) as any;
    expect(first).toMatchObject({
      revision: 1,
      assessment: "charging_recommended",
      estimated_final_percentage: 14,
    });
    const followUp = (await (
      await mcp("/api/trips", {
        trip_id: first.trip_id,
        reserve_percentage: 10,
      })
    ).json()) as any;
    expect(followUp).toMatchObject({
      trip_id: first.trip_id,
      revision: 2,
      destination: "Cottage",
      assessment: "within_reserve",
      minimum_departure_percentage: 42,
    });
    const listed = (await (await mcp("/api/trips")).json()) as any;
    expect(listed.trips).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(vin);
    expect(upstream).not.toHaveBeenCalled();
    expect((await mcp("/api/trips", { trip_id: "c".repeat(24) })).status).toBe(
      404,
    );
  });
  it("records outcomes and applies the learned factor to later plans", async () => {
    await store.putMany({ selected: { id, vin }, summary: reading(80, 400) });
    vi.stubGlobal("fetch", vi.fn());
    for (const end of [56, 56, 56]) {
      const trip = (await (
        await mcp("/api/trips", { legs: [{ to: "Office", distance_km: 100 }] })
      ).json()) as any;
      expect(trip.rated_battery_used_percentage).toBe(20);
      const recorded = (await (
        await mcp("/api/trips/outcome", {
          trip_id: trip.trip_id,
          actual_end_percentage: end,
        })
      ).json()) as any;
      expect(recorded.outcome).toMatchObject({
        predicted_used_percentage: 20,
        actual_used_percentage: 24,
        consumption_ratio: 1.2,
      });
    }
    const calibrated = (await (
      await mcp("/api/trips", { legs: [{ to: "Office", distance_km: 100 }] })
    ).json()) as any;
    expect(calibrated.calibration).toMatchObject({
      status: "applied",
      applied_factor: 1.2,
    });
    expect(calibrated.estimated_battery_used_percentage).toBe(24);
    expect(calibrated.rated_battery_used_percentage).toBe(20);
  });
  it("saves a destination without a route and without reading Tesla", async () => {
    await store.putMany({ selected: { id, vin } });
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const result = (await (
      await mcp("/api/trips", { destination: "Airport" })
    ).json()) as any;
    expect(result.assessment).toBe("route_required");
    expect(upstream).not.toHaveBeenCalled();
  });
  it("limits the MCP credential to planner writes", async () => {
    await store.putMany({ selected: { id, vin }, summary: reading() });
    for (const path of [
      "/api/vehicle/select",
      "/admin/alerts",
      "/admin/preferences",
    ])
      expect((await mcp(path, { id: "x" })).status).toBe(403);
  });
});
