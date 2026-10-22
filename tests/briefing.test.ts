import { expect, it } from "vitest";
import { briefSuggestions, deliverySchema } from "../src/context/briefing";
const now = Date.parse("2026-11-01T05:30:00Z"); // DST fall-back night in Toronto
const suggestion = {
  key: "event:instance:charge",
  kind: "review_trip_charge",
  message: "Review charging",
  suggested_review_at: new Date(now - 60000).toISOString(),
  expires_at: new Date(now + 3600000).toISOString(),
};
it("requires opt-in and never sends anything itself", () => {
  expect(briefSuggestions([suggestion], undefined, now)).toMatchObject({
    should_notify: false,
    reason: "notifications_not_enabled",
    delivery_executed: false,
  });
});
it("respects overnight quiet hours in the host time zone across DST", () => {
  const delivery = deliverySchema.parse({
    enabled: true,
    time_zone: "America/Toronto",
  });
  expect(briefSuggestions([suggestion], delivery, now).reason).toBe(
    "quiet_hours",
  );
  expect(briefSuggestions([suggestion], delivery, now + 3600000).reason).toBe(
    "quiet_hours",
  );
});
it("suppresses delivered, future and expired suggestions and bounds the batch", () => {
  const delivery = deliverySchema.parse({
    enabled: true,
    time_zone: "UTC",
    quiet_start_hour: 0,
    quiet_end_hour: 0,
    max_suggestions: 1,
    delivered_keys: [suggestion.key],
  });
  expect(briefSuggestions([suggestion], delivery, now).should_notify).toBe(
    false,
  );
  const fresh = { ...suggestion, key: "new" };
  const result = briefSuggestions(
    [
      fresh,
      { ...fresh, key: "second" },
      {
        ...fresh,
        key: "future",
        suggested_review_at: new Date(now + 1000).toISOString(),
      },
      { ...fresh, key: "expired", expires_at: new Date(now).toISOString() },
    ],
    delivery,
    now,
  );
  expect(result.should_notify).toBe(true);
  expect(result.suggestions.map((item) => item.key)).toEqual(["new"]);
});
it("rejects invalid time zones and unbounded notification history", () => {
  expect(deliverySchema.safeParse({ time_zone: "invalid-zone" }).success).toBe(
    false,
  );
  expect(
    deliverySchema.safeParse({
      time_zone: "UTC",
      delivered_keys: Array(201).fill("key"),
    }).success,
  ).toBe(false);
});
