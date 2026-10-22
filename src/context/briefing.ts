import { z } from "zod";

export const deliverySchema = z
  .object({
    enabled: z.boolean().default(false),
    time_zone: z
      .string()
      .max(100)
      .refine((zone) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: zone });
          return true;
        } catch {
          return false;
        }
      }, "Use a valid IANA time zone"),
    quiet_start_hour: z.number().int().min(0).max(23).default(22),
    quiet_end_hour: z.number().int().min(0).max(23).default(7),
    delivered_keys: z.array(z.string().min(1).max(500)).max(200).default([]),
    max_suggestions: z.number().int().min(1).max(3).default(3),
  })
  .strict();

export interface Suggestion {
  key: string;
  kind: string;
  message: string;
  suggested_review_at: string;
  expires_at: string;
}

// This computes eligibility only. The host owns consent, scheduling and delivery.
export function briefSuggestions(
  suggestions: Suggestion[],
  delivery: z.infer<typeof deliverySchema> | undefined,
  now = Date.now(),
) {
  const hour = delivery
    ? Number(
        new Intl.DateTimeFormat("en-GB", {
          timeZone: delivery.time_zone,
          hour: "2-digit",
          hourCycle: "h23",
        }).format(new Date(now)),
      )
    : null;
  const start = delivery?.quiet_start_hour,
    end = delivery?.quiet_end_hour;
  const quiet =
    hour !== null &&
    start !== undefined &&
    end !== undefined &&
    (start === end
      ? false
      : start < end
        ? hour >= start && hour < end
        : hour >= start || hour < end);
  const delivered = new Set(delivery?.delivered_keys ?? []);
  const eligible = suggestions.filter(
    (item) =>
      !delivered.has(item.key) &&
      Date.parse(item.suggested_review_at) <= now &&
      Date.parse(item.expires_at) > now,
  );
  return {
    should_notify: !!delivery?.enabled && !quiet && eligible.length > 0,
    reason: !delivery?.enabled
      ? "notifications_not_enabled"
      : quiet
        ? "quiet_hours"
        : eligible.length
          ? "suggestions_due"
          : "nothing_new_due",
    suggestions: eligible.slice(0, delivery?.max_suggestions ?? 3),
    delivery_executed: false,
    host_instruction:
      "Send only through the user's opted-in host channel. Record keys only after successful delivery; recheck event validity before sending. This tool does not create a schedule or grant notification permission.",
  };
}
