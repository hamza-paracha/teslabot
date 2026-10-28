import {
  HISTORY_LIMIT,
  HISTORY_RETENTION_MS,
  type Observation,
} from "./observations";

const HOUR = 3600000;
const nonCharging = new Set(["Disconnected", "Stopped", "Complete", "NoPower"]);

// Calendar arithmetic on local date labels, not elapsed hours (DST nights vary).
function previousDate(date: string) {
  return new Date(Date.parse(date) - 86400000).toISOString().slice(0, 10);
}

export function detectRoutines(
  history: Observation[],
  vehicleId: string | null,
  timeZone?: string,
  now = Date.now(),
) {
  const zone = timeZone ?? "UTC";
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const local = (time: number) => {
    const parts = Object.fromEntries(
      formatter.formatToParts(time).map((p) => [p.type, p.value]),
    );
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    const hour = Number(parts.hour);
    return {
      date,
      hour,
      night: hour >= 22 ? date : hour < 7 ? previousDate(date) : null,
    };
  };
  const seen = new Set<number>();
  const samples = history
    .filter((o) => o.vehicle.id === vehicleId)
    .map((o) => ({
      time: Date.parse(o.data.sections?.charging?.observed_at ?? ""),
      retrieved: Date.parse(o.data.retrieved_at),
      state: o.charging.state,
    }))
    .filter(
      (o) =>
        Number.isFinite(o.time) &&
        o.time >= now - HISTORY_RETENTION_MS &&
        o.time <= now &&
        o.retrieved >= now - HISTORY_RETENTION_MS &&
        o.retrieved <= now &&
        o.time <= o.retrieved + 60000,
    )
    .sort((a, b) => a.time - b.time)
    .filter((o) => {
      if (seen.has(o.time)) return false;
      seen.add(o.time);
      return true;
    })
    .slice(-HISTORY_LIMIT);
  const today = local(now);
  const lastNight = previousDate(
    today.hour >= 7 ? today.date : previousDate(today.date),
  );
  const starts = samples.flatMap((sample, index) => {
    const before = samples[index - 1];
    if (
      !before ||
      !nonCharging.has(before.state ?? "") ||
      sample.state !== "Charging" ||
      sample.time - before.time > 3 * HOUR
    )
      return [];
    const night = local(sample.time).night;
    return [
      {
        night: night && local(before.time).night === night ? night : null,
        from: new Date(before.time).toISOString(),
        to: new Date(sample.time).toISOString(),
      },
    ];
  });
  const overnight = starts.filter((s) => s.night !== null);
  const nights = new Set(overnight.map((s) => s.night));
  const enough = nights.size >= 3 && overnight.length / starts.length >= 0.75;
  const baselineNights = new Set(
    overnight.filter((s) => s.night! < lastNight).map((s) => s.night),
  );
  const lastSamples = samples.filter((s) => local(s.time).night === lastNight);
  const covered =
    lastSamples.length >= 4 &&
    local(lastSamples[0].time).hour === 22 &&
    local(lastSamples[lastSamples.length - 1].time).hour === 6 &&
    lastSamples.every(
      (s, i) => !i || s.time - lastSamples[i - 1].time <= 3 * HOUR,
    );
  const deviation =
    enough &&
    baselineNights.size >= 3 &&
    covered &&
    lastSamples.every((s) => nonCharging.has(s.state ?? ""));
  return {
    assessment: enough ? "routine_observed" : "insufficient_data",
    confidence: enough ? "low" : "insufficient_data",
    sample_size: samples.length,
    observed_range: {
      from: samples.length ? new Date(samples[0].time).toISOString() : null,
      to: samples.length
        ? new Date(samples[samples.length - 1].time).toISOString()
        : null,
    },
    time_zone: zone,
    time_zone_source: timeZone ? "configured" : "utc_fallback",
    charging: {
      assessment: enough ? "usually_starts_overnight" : "insufficient_data",
      message: enough
        ? "Charging usually starts overnight in the observed samples."
        : "At least three distinct nights with observed charging transitions and 75% overnight transitions are required.",
      window: { start_hour: 22, end_hour: 7 },
      observed_start_intervals: starts,
      overnight_start_count: overnight.length,
      start_count: starts.length,
      nights_with_overnight_starts: nights.size,
    },
    deviation: {
      assessment: deviation ? "no_charging_observed" : "insufficient_data",
      night_start_date: lastNight,
      sample_size: lastSamples.length,
      baseline_nights: baselineNights.size,
      confidence: deviation ? "low" : "insufficient_data",
      message: deviation
        ? "No charging was observed in last night's samples, unlike the recent overnight routine."
        : "Insufficient evidence for a missing overnight charging deviation.",
    },
    limitations: [
      ...(timeZone ? [] : ["No time zone is configured; overnight uses UTC."]),
      "Only requested observations from the last seven days are used; this is not continuous monitoring.",
      "Starts are bracketed by known non-charging and charging samples at most three hours apart; exact start times are unknown.",
      "A missing-night comparison requires three earlier routine nights and non-charging samples from 22:00 through 06:00 with gaps at most three hours. Charging between samples cannot be ruled out.",
      "Confidence is low because sampling is sparse and may be biased; no prediction or alert is guaranteed.",
    ],
  };
}
