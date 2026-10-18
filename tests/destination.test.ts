import { expect, it } from "vitest";
import {
  assessDestination,
  destinationSchema,
} from "../src/context/destination";
import { normalize } from "../src/tesla/normalization";
function observation(at = Date.now()) {
  return normalize(
    {
      charge_state: {
        battery_level: 80,
        battery_range: 200 / 1.609344,
        timestamp: at,
      },
    },
    "opaque",
    null,
    false,
  );
}
const input = () =>
  destinationSchema.parse({
    destination: "Meeting venue",
    origin: "Confirmed departure location",
    route: { source: "host-routing-test-fixture", one_way_distance_km: 50 },
  });
it("estimates battery at the destination and after returning, disclosing a mirrored return route", () => {
  const result = assessDestination(input(), observation());
  expect(result.one_way?.estimated_arrival_percentage).toBe(60);
  expect(result.round_trip?.estimated_arrival_percentage).toBe(40);
  expect(result.return_distance_assumed).toBe(true);
  expect(result.assumptions.join(" ")).toContain("no charging between legs");
});
it("uses actual asymmetric return distance when supplied", () => {
  const value = input();
  value.route!.return_distance_km = 75;
  const result = assessDestination(value, observation());
  expect(result.round_trip?.estimated_arrival_percentage).toBe(30);
  expect(result.return_distance_assumed).toBe(false);
});
it("does not invent routes or answer confidently with stale battery data", () => {
  expect(
    assessDestination(
      destinationSchema.parse({ destination: "Somewhere" }),
      null,
    ).assessment,
  ).toBe("route_required");
  expect(
    assessDestination(input(), observation(Date.now() - 600000)).round_trip
      ?.estimated_arrival_percentage,
  ).toBeNull();
});
it("does not claim an arrival percentage for a trip beyond reported range", () => {
  const value = input();
  value.route!.one_way_distance_km = 250;
  const result = assessDestination(value, observation());
  expect(result.one_way?.estimated_arrival_percentage).toBeNull();
  expect(result.one_way?.reported_range_shortfall_km).toBe(50);
  expect(result.round_trip?.assessment).toBe("charging_recommended");
});
