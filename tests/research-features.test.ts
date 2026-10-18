import { expect, it } from "vitest";
import { normalize } from "../src/tesla/normalization";
import { readiness } from "../src/context/readiness";
import { chargingPlanSchema, planCharging } from "../src/context/charging";
function sample() {
  return normalize(
    {
      charge_state: {
        battery_level: 40,
        charger_power: 10,
        charge_energy_added: 12.3,
        charge_rate: 20,
        timestamp: Date.now(),
      },
      vehicle_state: {
        locked: false,
        df: 1,
        fd_window: 0,
        tpms_pressure_fl: 2.9,
        tpms_soft_warning_fl: true,
        tpms_hard_warning_fl: false,
        timestamp: Date.now(),
      },
    },
    "opaque",
    null,
    false,
  );
}
it("normalizes reported closures, bar/PSI and Tesla warning flags without filling missing values", () => {
  const result = sample();
  expect(result.closures.doors.driver_front).toBe(true);
  expect(result.closures.windows.driver_front).toBe(false);
  expect(result.closures.doors.passenger_front).toBeNull();
  expect(result.tires.front_left.pressure_psi).toBe(42.1);
  expect(result.tires.rear_left.pressure_bar).toBeNull();
  expect(result.charging.session_energy_added_kwh).toBe(12.3);
  expect(result.charging.range_added_km_per_hour).toBeCloseTo(32.18688);
});
it("reports attention and unknown sensors without declaring the car safe", () => {
  const report = readiness(sample());
  expect(report.assessment).toBe("attention_needed");
  expect(report.attention.map((item) => item.code)).toContain(
    "tire_front_left_soft_warning",
  );
  expect(report.attention.map((item) => item.code)).toContain(
    "doors_driver_front_open",
  );
  expect(report.unavailable_checks).toContain("rear_trunk_open");
  expect(report.limitations.join(" ")).toContain("not a vehicle inspection");
});
it("never treats missing sensors as a clean inspection", () => {
  expect(
    readiness(
      normalize(
        { vehicle_state: { timestamp: Date.now() } },
        "id",
        null,
        false,
      ),
    ).assessment,
  ).toBe("partial_data");
});
it("labels historical readiness observations instead of sounding current", () => {
  const observation = sample();
  observation.data.observed_at = new Date(Date.now() - 600000).toISOString();
  expect(readiness(observation).assessment).toBe("stale_observation");
});
it("does not treat zero reported pressure as a verified flat tire or normal pressure", () => {
  const observation = normalize(
    { vehicle_state: { tpms_pressure_fl: 0, timestamp: Date.now() } },
    "id",
    null,
    false,
  );
  expect(observation.tires.front_left.pressure_bar).toBeNull();
  expect(readiness(observation).attention).toEqual([]);
});
it("estimates energy, duration and tariff cost using explicit capacity and efficiency", () => {
  const plan = planCharging(
    sample(),
    chargingPlanSchema.parse({
      target_percentage: 80,
      usable_capacity_kwh: 75,
      electricity_price_per_kwh: 0.15,
    }),
  );
  expect(plan.estimated_battery_energy_kwh).toBe(30);
  expect(plan.estimated_grid_energy_kwh).toBe(33.33);
  expect(plan.estimated_duration_hours).toBe(3.33);
  expect(plan.estimated_cost).toBe(5);
  expect(plan.assumptions.capacity_source).toBe("supplied_by_caller");
});
it("does not invent a tariff or charger power", () => {
  const observation = sample();
  observation.charging.power_kw = null;
  const plan = planCharging(
    observation,
    chargingPlanSchema.parse({
      target_percentage: 80,
      usable_capacity_kwh: 75,
    }),
  );
  expect(plan.estimated_cost).toBeNull();
  expect(plan.estimated_duration_hours).toBeNull();
});
it("refuses a confident charge plan when source charge timestamps are missing", () => {
  const observation = sample();
  observation.data.sections.charging.is_stale = true;
  observation.data.sections.charging.observed_at = null;
  const plan = planCharging(
    observation,
    chargingPlanSchema.parse({
      target_percentage: 80,
      usable_capacity_kwh: 75,
    }),
  );
  expect(plan.assessment).toBe("insufficient_fresh_data");
  expect(plan.estimated_cost).toBeNull();
});
it("does not plan to remove energy when the target is already met", () => {
  const plan = planCharging(
    sample(),
    chargingPlanSchema.parse({
      target_percentage: 30,
      usable_capacity_kwh: 75,
    }),
  );
  expect(plan.assessment).toBe("target_already_met");
  expect(plan.estimated_battery_energy_kwh).toBe(0);
});
it("requires an actual capacity and rejects impossible efficiency", () => {
  expect(chargingPlanSchema.safeParse({ target_percentage: 80 }).success).toBe(
    false,
  );
  expect(
    chargingPlanSchema.safeParse({
      target_percentage: 80,
      usable_capacity_kwh: 75,
      charging_efficiency: 1.5,
    }).success,
  ).toBe(false);
});
