import { z } from "zod";
import { refreshObservation, type Observation } from "./observations";

const timeZone = z
  .string()
  .max(100)
  .refine((zone) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }, "Use a valid IANA time zone");
const instant = z
  .string()
  .max(40)
  .refine(
    (value) =>
      /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)),
    "Use an ISO timestamp with a UTC offset",
  );
// Calendar text is untrusted; keep it short and printable before storing or sending it.
const text = (max: number) =>
  z
    .string()
    .transform((value) =>
      value
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .trim()
        .slice(0, max),
    )
    .pipe(z.string().min(1));

export const alertSettingsSchema = z
  .object({
    enabled: z.boolean(),
    time_zone: timeZone,
    notify: z
      .object({
        format: z.enum(["ntfy", "json"]),
        // Omit url to keep the stored destination.
        url: z
          .string()
          .max(500)
          .url()
          .refine((value) => {
            const u = new URL(value);
            return u.protocol === "https:" && !u.username && !u.password;
          }, "Use an https URL without embedded credentials")
          .optional(),
      })
      .strict()
      .nullable(),
    plug_in: z
      .object({
        enabled: z.boolean().default(true),
        local_hour: z.number().int().min(0).max(23).default(21),
        below_percentage: z.number().int().min(10).max(95).default(50),
      })
      .strict()
      .default({ enabled: true, local_hour: 21, below_percentage: 50 }),
    briefings: z
      .object({
        enabled: z.boolean().default(true),
        lead_minutes: z.number().int().min(10).max(180).default(45),
        reserve_percentage: z.number().min(5).max(50).default(20),
        only_when_tight: z.boolean().default(true),
      })
      .strict()
      .default({
        enabled: true,
        lead_minutes: 45,
        reserve_percentage: 20,
        only_when_tight: true,
      }),
  })
  .strict();
export type AlertSettings = Omit<
  z.infer<typeof alertSettingsSchema>,
  "notify"
> & { notify: { format: "ntfy" | "json"; url: string } | null };

export const briefingsSchema = z
  .object({
    events: z
      .array(
        z
          .object({
            event_id: z.string().min(1).max(200),
            title: text(120),
            departs_at: instant,
            total_distance_km: z.number().positive().max(5000).optional(),
            cancelled: z.boolean().default(false),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();
export interface Briefing {
  event_id: string;
  title: string;
  departs_at: string;
  total_distance_km: number | null;
  updated_at: string;
}
export const BRIEFING_LIMIT = 20;

export interface AlertState {
  plug_in_checked_date: string | null;
  // event_id -> departs_at that was already handled, so a moved event is checked again.
  handled: Record<string, string>;
  last_sent_at: string | null;
  last_error: string | null;
}
export const defaultAlertState: AlertState = {
  plug_in_checked_date: null,
  handled: {},
  last_sent_at: null,
  last_error: null,
};

export interface Notification {
  kind: "plug_in_reminder" | "departure_briefing" | "test";
  title: string;
  message: string;
}

export function localParts(now: number, zone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(now))
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
  };
}
const clock = (at: number, zone: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(at));

// Merge host-supplied events: a moved event replaces the old time, cancelled removes it.
export function mergeBriefings(
  existing: Briefing[],
  input: z.infer<typeof briefingsSchema>,
  now = Date.now(),
) {
  const items = new Map(
    existing
      .filter((item) => Date.parse(item.departs_at) > now)
      .map((item) => [item.event_id, item]),
  );
  for (const event of input.events) {
    if (event.cancelled || Date.parse(event.departs_at) <= now)
      items.delete(event.event_id);
    else
      items.set(event.event_id, {
        event_id: event.event_id,
        title: event.title,
        departs_at: new Date(Date.parse(event.departs_at)).toISOString(),
        total_distance_km: event.total_distance_km ?? null,
        updated_at: new Date(now).toISOString(),
      });
  }
  return [...items.values()]
    .sort((a, b) => Date.parse(a.departs_at) - Date.parse(b.departs_at))
    .slice(0, BRIEFING_LIMIT);
}

function reading(observation: Observation | null, zone: string, now: number) {
  if (!observation || observation.battery.percentage === null) return null;
  const current = refreshObservation(observation, now);
  const fresh =
    !current.data.is_stale &&
    current.data.sections?.battery?.is_stale === false;
  const at = current.data.observed_at
    ? Date.parse(current.data.observed_at)
    : NaN;
  return {
    percentage: current.battery.percentage!,
    range_km: current.battery.range_km,
    connected: current.charging.connected,
    fresh,
    label: fresh
      ? "Battery is"
      : Number.isFinite(at)
        ? `As of ${clock(at, zone)}, battery was`
        : "Last known battery was",
  };
}

export function plugInReminder(
  observation: Observation | null,
  settings: AlertSettings,
  now = Date.now(),
): Notification | null {
  const battery = reading(observation, settings.time_zone, now);
  // Unknown plug state is not evidence the car is unplugged.
  if (!battery || battery.connected !== false) return null;
  if (battery.percentage >= settings.plug_in.below_percentage) return null;
  return {
    kind: "plug_in_reminder",
    title: "Plug in tonight?",
    message: `${battery.label} ${battery.percentage}% and the car isn't plugged in. Plug in tonight if you're driving tomorrow.`,
  };
}

export function departureBriefing(
  item: Briefing,
  observation: Observation | null,
  settings: AlertSettings,
  now = Date.now(),
): Notification | null {
  const zone = settings.time_zone,
    reserve = settings.briefings.reserve_percentage;
  const battery = reading(observation, zone, now);
  const leave = `${item.title}: leave around ${clock(Date.parse(item.departs_at), zone)}.`;
  if (!battery)
    return settings.briefings.only_when_tight
      ? null
      : {
          kind: "departure_briefing",
          title: "Departure check",
          message: `${leave} No battery reading is available; check the Tesla app before you go.`,
        };
  const distance = item.total_distance_km;
  const after =
    distance && battery.range_km
      ? battery.percentage * (1 - distance / battery.range_km)
      : null;
  const tight = after !== null && after < reserve;
  if (settings.briefings.only_when_tight && !tight) return null;
  const estimate =
    after === null
      ? ""
      : after <= 0
        ? ` The ${distance} km trip is beyond the reported range.`
        : ` About ${Math.round(after)}% would be left after ${distance} km.`;
  return {
    kind: "departure_briefing",
    title: tight ? "Charge before you leave" : "Departure check",
    message: `${leave} ${battery.label} ${battery.percentage}%.${estimate}${tight ? ` That's below your ${reserve}% reserve.` : ""} Estimate only, from Tesla's reported range.`,
  };
}
