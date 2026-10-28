import { expect, it } from "vitest";
import { normalize } from "../src/tesla/normalization";
import { detectRoutines } from "../src/context/routines";
import { preferencesSchema } from "../src/context/observations";

const now = Date.parse("2026-10-27T15:00:00Z");
function sample(time: string, state = "Charging", id = "opaque") {
  const observation = normalize(
    { charge_state: { charging_state: state, timestamp: Date.parse(time) } },
    id,
    null,
    false,
  );
  observation.data.retrieved_at = time;
  observation.data.sections.charging.observed_at = time;
  return observation;
}
const routine = () =>
  [23, 24, 25].flatMap((day) => [
    sample(`2026-10-${day}T22:00:00Z`, "Stopped"),
    sample(`2026-10-${day}T23:00:00Z`),
  ]);

it("requires three distinct nights and exposes sample size, source range and low confidence", () => {
  expect(
    detectRoutines(routine().slice(0, 4), "opaque", undefined, now),
  ).toMatchObject({
    assessment: "insufficient_data",
    confidence: "insufficient_data",
  });
  const result = detectRoutines(routine(), "opaque", undefined, now);
  expect(result).toMatchObject({
    assessment: "routine_observed",
    confidence: "low",
    sample_size: 6,
    time_zone: "UTC",
    time_zone_source: "utc_fallback",
    observed_range: {
      from: "2026-10-23T22:00:00.000Z",
      to: "2026-10-25T23:00:00.000Z",
    },
    charging: {
      overnight_start_count: 3,
      start_count: 3,
      nights_with_overnight_starts: 3,
    },
    deviation: { assessment: "insufficient_data" },
  });
  expect(result.limitations.join(" ")).toContain("uses UTC");
});

it("sorts and deduplicates charging section timestamps without mutating input", () => {
  const history = routine().reverse();
  history.push(history[0]);
  const original = JSON.stringify(history);
  // A different section timestamp must not turn a cached charge sample into a new start.
  history[0].data.observed_at = "2026-10-26T23:00:00Z";
  expect(detectRoutines(history, "opaque", undefined, now).sample_size).toBe(6);
  history[0].data.observed_at = JSON.parse(original)[0].data.observed_at;
  expect(JSON.stringify(history)).toBe(original);
});

it("uses configured local nights including DST, rather than UTC hours", () => {
  const history = [3, 4, 5].flatMap((day) => [
    sample(`2026-11-0${day}T03:00:00Z`, "Stopped"),
    sample(`2026-11-0${day}T04:00:00Z`),
  ]);
  const time = Date.parse("2026-11-06T15:00:00Z");
  expect(
    detectRoutines(history, "opaque", "America/Toronto", time),
  ).toMatchObject({
    assessment: "routine_observed",
    time_zone_source: "configured",
  });
  // UTC 03:00-04:00 is also overnight, but the night date differs.
  expect(
    detectRoutines(history, "opaque", "America/Toronto", time).charging
      .observed_start_intervals[0].night,
  ).toBe("2026-11-02");
  const afternoon = routine().map((o) =>
    sample(
      o.data.retrieved_at.replace("T22:", "T02:").replace("T23:", "T03:"),
      o.charging.state!,
    ),
  );
  expect(
    detectRoutines(afternoon, "opaque", "Asia/Tokyo", now).assessment,
  ).toBe("insufficient_data");
  expect(detectRoutines(afternoon, "opaque", undefined, now).assessment).toBe(
    "routine_observed",
  );
});

it("keeps a start interval on one local night across the daylight-saving fallback", () => {
  const history = [
    ["2026-10-30T02:00:00Z", "2026-10-30T03:00:00Z"],
    ["2026-10-31T02:00:00Z", "2026-10-31T03:00:00Z"],
    ["2026-11-01T04:00:00Z", "2026-11-01T06:00:00Z"],
  ].flatMap(([from, to]) => [sample(from, "Stopped"), sample(to)]);
  const result = detectRoutines(
    history,
    "opaque",
    "America/Toronto",
    Date.parse("2026-11-01T12:00:00Z"),
  );
  expect(result.assessment).toBe("routine_observed");
  expect(result.charging.observed_start_intervals[2].night).toBe("2026-10-31");
  expect(result.deviation.night_start_date).toBe("2026-10-31");
});

it("does not infer starts from unknown states, long gaps, or charging-only samples", () => {
  for (const state of ["Unknown", "Starting", null]) {
    const history = routine();
    history[0].charging.state = state;
    expect(detectRoutines(history, "opaque", undefined, now).assessment).toBe(
      "insufficient_data",
    );
  }
  const history = routine();
  history[0] = sample("2026-10-23T18:00:00Z", "Stopped");
  expect(detectRoutines(history, "opaque", undefined, now).assessment).toBe(
    "insufficient_data",
  );
  expect(
    detectRoutines(
      routine().filter((_, i) => i % 2),
      "opaque",
      undefined,
      now,
    ).assessment,
  ).toBe("insufficient_data");
});

it("rejects a usual-night claim when fewer than 75% of observed starts are overnight", () => {
  const daytime = [26, 27].flatMap((day) => [
    sample(`2026-10-${day}T10:00:00Z`, "Stopped"),
    sample(`2026-10-${day}T11:00:00Z`),
  ]);
  expect(
    detectRoutines([...routine(), ...daytime], "opaque", undefined, now)
      .assessment,
  ).toBe("insufficient_data");
});

it("ignores expired, future, other-vehicle and missing charging timestamp samples and caps at 48", () => {
  const missing = sample("2026-10-26T23:00:00Z");
  missing.data.sections.charging.observed_at = null;
  expect(
    detectRoutines(
      [
        missing,
        sample("2026-10-19T23:00:00Z"),
        sample("2026-10-28T23:00:00Z"),
        sample("2026-10-26T23:00:00Z", "Charging", "other"),
      ],
      "opaque",
      undefined,
      now,
    ),
  ).toMatchObject({
    sample_size: 0,
    observed_range: { from: null, to: null },
    assessment: "insufficient_data",
  });
  const many = Array.from({ length: 60 }, (_, i) =>
    sample(new Date(now - (i + 1) * 60000).toISOString()),
  );
  expect(detectRoutines(many, "opaque", undefined, now).sample_size).toBe(48);
});

it("reports only sampled absence with adequate last-night coverage and three earlier nights", () => {
  const lastNight = [
    "2026-10-26T22:00:00Z",
    "2026-10-27T01:00:00Z",
    "2026-10-27T04:00:00Z",
    "2026-10-27T06:00:00Z",
  ].map((time) => sample(time, "Stopped"));
  const result = detectRoutines(
    [...routine(), ...lastNight],
    "opaque",
    undefined,
    now,
  );
  expect(result.deviation).toMatchObject({
    assessment: "no_charging_observed",
    night_start_date: "2026-10-26",
    baseline_nights: 3,
    sample_size: 4,
    confidence: "low",
  });
  expect(result.limitations.join(" ")).toContain(
    "Charging between samples cannot be ruled out",
  );
  for (const history of [
    lastNight,
    [...routine(), ...lastNight.slice(1)],
    [...routine(), ...lastNight.filter((_, i) => i !== 1)],
  ]) {
    expect(
      detectRoutines(history, "opaque", undefined, now).deviation.assessment,
    ).toBe("insufficient_data");
  }
  lastNight[1].charging.state = "Charging";
  expect(
    detectRoutines([...routine(), ...lastNight], "opaque", undefined, now)
      .deviation.assessment,
  ).toBe("insufficient_data");
  // At 05:00 the current night is incomplete; the comparison is the prior completed night.
  expect(
    detectRoutines(
      routine(),
      "opaque",
      undefined,
      Date.parse("2026-10-27T05:00:00Z"),
    ).deviation.night_start_date,
  ).toBe("2026-10-25");
});

it("validates optional IANA preference without requiring it for existing preferences", () => {
  const base = {
    history_enabled: true,
    battery_change_percentage: 5,
    temperature_change_c: 3,
  };
  expect(preferencesSchema.safeParse(base).success).toBe(true);
  expect(
    preferencesSchema.safeParse({ ...base, time_zone: "America/Toronto" })
      .success,
  ).toBe(true);
  expect(
    preferencesSchema.safeParse({ ...base, time_zone: "invalid/timezone" })
      .success,
  ).toBe(false);
});
