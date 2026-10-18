import { expect, it } from "vitest";
import { departureSchema, planDepartures } from "../src/context/departure";
const now = Date.parse("2026-10-18T12:00:00Z");
function input() {
  return departureSchema.parse({
    events: [
      {
        id: "meeting",
        title: "Office",
        starts_at: "2026-10-19T09:00:00-04:00",
        location: "Office",
        travel_minutes: 30,
      },
    ],
    departure_forecast: {
      source: "host-weather-test-fixture",
      location_label: "Departure city",
      issued_at: new Date(now).toISOString(),
      hours: [{ at: "2026-10-19T08:00:00-04:00", temperature_c: -4 }],
    },
  });
}
it("offers a review of cabin preparation using host calendar and departure weather without commands", () => {
  const result = planDepartures(input(), null, now);
  expect(result.plans[0].departure_at).toBe("2026-10-19T12:30:00.000Z");
  expect(result.plans[0].proposals[0]).toMatchObject({
    kind: "offer_cabin_preconditioning",
    requires_confirmation: true,
    executable: false,
  });
  expect(result.actions_executed).toBe(false);
  expect(result.plans[0].trip).toBeNull();
});
it("does not treat an event start time as a departure or invent missing weather", () => {
  const value = input();
  delete value.events[0].travel_minutes;
  const result = planDepartures(value, null, now);
  expect(result.plans[0].departure_at).toBeNull();
  expect(result.plans[0].proposals).toEqual([]);
  expect(result.plans[0].missing_context.join(" ")).toContain(
    "not a departure time",
  );
});
it("excludes cancelled, past and location-free events and deduplicates input", () => {
  const value = input();
  value.events.push(
    { ...value.events[0] },
    { ...value.events[0], id: "cancelled", cancelled: true },
    { ...value.events[0], id: "virtual", location: "" },
    { ...value.events[0], id: "past", starts_at: "2026-10-17T13:00:00Z" },
  );
  expect(planDepartures(value, null, now).plans).toHaveLength(1);
});
it("rejects stale forecasts, unmatched hours and already-passed departure times", () => {
  const value = input();
  value.departure_forecast!.issued_at = new Date(
    now - 7 * 3600000,
  ).toISOString();
  expect(planDepartures(value, null, now).plans[0].proposals).toEqual([]);
  value.departure_forecast!.issued_at = new Date(now).toISOString();
  value.departure_forecast!.hours[0].at = "2026-10-19T00:00:00Z";
  expect(planDepartures(value, null, now).plans[0].proposals).toEqual([]);
  value.events[0].starts_at = new Date(now + 60000).toISOString();
  expect(planDepartures(value, null, now).plans[0].proposals).toEqual([]);
});
it("requires bounded inputs and unambiguous time zones", () => {
  const value = input();
  value.events[0].starts_at = "2026-10-19T09:00:00";
  expect(departureSchema.safeParse(value).success).toBe(false);
  expect(
    departureSchema.safeParse({ events: Array(31).fill(input().events[0]) })
      .success,
  ).toBe(false);
});
