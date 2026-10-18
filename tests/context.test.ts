import { describe, expect, it } from "vitest";
import {
  appendHistory,
  buildContext,
  defaultPreferences,
  describeChanges,
  estimateTrip,
  freshness,
  HISTORY_RETENTION_MS,
} from "../src/context/observations";
import { normalize } from "../src/tesla/normalization";
function sample(
  at = Date.now(),
  battery = 70,
  state = "Charging",
  id = "opaque",
) {
  return normalize(
    {
      charge_state: {
        battery_level: battery,
        battery_range: 200,
        charging_state: state,
        timestamp: at,
      },
      climate_state: { inside_temp: 18, timestamp: at },
      vehicle_state: { locked: true, timestamp: at },
    },
    id,
    "Car",
    false,
  );
}
describe("grounded personal context", () => {
  it("uses historical wording and cannot invent a charging stop time", () => {
    const now = sample(Date.now() - 600000, 60, "Complete");
    const before = sample(Date.now() - 1200000);
    const context = buildContext(now, before, defaultPreferences);
    expect(context.narrative).toContain("Last known battery");
    expect(context.data.is_stale).toBe(true);
    expect(
      context.changes.find((c) => c.kind === "charging")?.message,
    ).toContain("exact transition time is unknown");
    expect(context.limitations.join(" ")).toContain("No trip history");
  });
  it("returns no change when observations are reordered, duplicated or from another vehicle", () => {
    const current = sample();
    expect(describeChanges(current, current, defaultPreferences)).toEqual([]);
    expect(
      describeChanges(sample(Date.now() + 1000), current, defaultPreferences),
    ).toEqual([]);
    expect(
      describeChanges(
        sample(Date.now() - 1000, 10, "Charging", "another"),
        current,
        defaultPreferences,
      ),
    ).toEqual([]);
  });
  it("respects user thresholds", () => {
    const previous = sample(Date.now() - 1000, 68),
      current = sample();
    expect(describeChanges(previous, current, defaultPreferences)).toEqual([]);
    expect(
      describeChanges(previous, current, {
        ...defaultPreferences,
        battery_change_percentage: 1,
      }),
    ).toHaveLength(1);
  });
  it("does not invent unavailable readings", () => {
    const context = buildContext(
      normalize({ charge_state: { timestamp: Date.now() } }, "id", null, false),
      null,
      defaultPreferences,
    );
    expect(context.narrative).toBe(
      "No supported vehicle readings are available in this observation.",
    );
  });
  it("treats unknown and future observation times as stale", () => {
    expect(freshness(null).is_stale).toBe(true);
    expect(
      freshness(new Date(Date.now() + 120000).toISOString()).is_stale,
    ).toBe(true);
  });
  it("handles extreme upstream timestamps without throwing or marking them fresh", () => {
    const current = normalize(
      { charge_state: { timestamp: 1e100, battery_level: 70 } },
      "id",
      null,
      false,
    );
    expect(current.data.sections.battery.is_stale).toBe(true);
  });
});
describe("bounded observation history", () => {
  it("does not duplicate source observations and removes other vehicles and expired samples", () => {
    const now = sample();
    const old = sample(Date.now() - HISTORY_RETENTION_MS - 1000);
    old.data.retrieved_at = new Date(
      Date.now() - HISTORY_RETENTION_MS - 1000,
    ).toISOString();
    expect(
      appendHistory(
        [old, sample(Date.now() - 1000, 50, "Charging", "different"), now],
        now,
      ),
    ).toEqual([now]);
  });
  it("keeps at most 48 observations", () => {
    const values = Array.from({ length: 60 }, (_, i) =>
      sample(Date.now() - (60 - i) * 1000),
    );
    expect(appendHistory(values, sample())).toHaveLength(48);
  });
});
describe("trip estimate", () => {
  it("states assumptions and uses the caller's total distance and reserve", () => {
    const result = estimateTrip(sample(), {
      distance_km: 100,
      reserve_percentage: 20,
    });
    expect(result.assessment).toBe("within_reported_range_estimate");
    expect(result.estimated_arrival_percentage).toBeGreaterThan(40);
    expect(result.assumptions.join(" ")).toContain("every leg");
    expect(result.limitations.join(" ")).toContain("not a guarantee");
  });
  it("recommends charging when the reserve is not met", () => {
    expect(
      estimateTrip(sample(), { distance_km: 300, reserve_percentage: 20 })
        .assessment,
    ).toBe("charging_recommended");
  });
  it("refuses a confident answer for stale, missing or zero range", () => {
    expect(
      estimateTrip(sample(Date.now() - 600000), {
        distance_km: 100,
        reserve_percentage: 20,
      }).assessment,
    ).toBe("insufficient_fresh_data");
    const current = sample();
    current.battery.range_km = 0;
    expect(
      estimateTrip(current, { distance_km: 100, reserve_percentage: 20 })
        .estimated_arrival_percentage,
    ).toBeNull();
  });
  it("does not use battery readings whose own timestamp is missing", () => {
    const current = normalize(
      {
        charge_state: { battery_level: 80, battery_range: 200 },
        climate_state: { timestamp: Date.now() },
      },
      "id",
      null,
      false,
    );
    expect(
      estimateTrip(current, { distance_km: 100, reserve_percentage: 20 })
        .assessment,
    ).toBe("insufficient_fresh_data");
  });
});
