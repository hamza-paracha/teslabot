import type { Env } from "../types";
import { AppError } from "../types";
import { Store } from "../storage/database";
import { json, readJson } from "./http";
import { sendNotification } from "../notify";
import {
  alertSettingsSchema,
  briefingsSchema,
  defaultAlertState,
  mergeBriefings,
  type AlertSettings,
  type Briefing,
} from "../context/alerts";

// The destination URL often embeds a secret topic or token; show only its host.
function visible(settings: AlertSettings | null) {
  return settings
    ? {
        ...settings,
        notify: settings.notify
          ? {
              format: settings.notify.format,
              host: new URL(settings.notify.url).host,
              configured: true,
            }
          : null,
      }
    : null;
}

export async function alertRoute(
  r: Request,
  e: Env,
  store: Store,
): Promise<Response | null> {
  const p = new URL(r.url).pathname;
  if (p === "/admin/alerts" && r.method === "GET") {
    const stored = await store.getMany(["alert_settings", "alert_state"]);
    const { handled: _handled, ...state } = {
      ...defaultAlertState,
      ...stored.alert_state,
    };
    return json({ settings: visible(stored.alert_settings), state });
  }
  if (p === "/admin/alerts" && r.method === "POST") {
    const parsed = alertSettingsSchema.safeParse(await readJson(r, 4096));
    if (!parsed.success) throw new AppError("invalid_alert_settings");
    const saved = await store.locked(
      "alerts",
      async () => {
        const previous = await store.get<AlertSettings>("alert_settings");
        const url = parsed.data.notify
          ? (parsed.data.notify.url ?? previous?.notify?.url)
          : undefined;
        if (parsed.data.notify && !url)
          throw new AppError("notification_url_required");
        const settings: AlertSettings = {
          ...parsed.data,
          notify: parsed.data.notify
            ? { format: parsed.data.notify.format, url: url! }
            : null,
        };
        if (settings.enabled && !settings.notify)
          throw new AppError("notification_url_required");
        await store.put("alert_settings", settings);
        return settings;
      },
      10000,
    );
    await store.audit("alert_settings_updated");
    return json({ settings: visible(saved) });
  }
  if (p === "/admin/alerts/test" && r.method === "POST") {
    const settings = await store.get<AlertSettings>("alert_settings");
    if (!settings?.notify) throw new AppError("notification_url_required");
    await sendNotification(settings.notify, {
      kind: "test",
      title: "teslabot test",
      message: "Notifications from teslabot will arrive here.",
    });
    return json({ sent: true });
  }
  if (p === "/api/briefings" && r.method === "GET") {
    const stored = await store.getMany(["briefings", "alert_settings"]);
    const settings: AlertSettings | null = stored.alert_settings;
    return json({
      briefings: (stored.briefings?.items ?? []).filter(
        (item: Briefing) => Date.parse(item.departs_at) > Date.now(),
      ),
      delivery: deliveryStatus(settings),
    });
  }
  if (p === "/api/briefings" && r.method === "POST") {
    const parsed = briefingsSchema.safeParse(await readJson(r, 16384));
    if (!parsed.success) throw new AppError("invalid_briefings");
    const items = await store.locked(
      "briefings",
      async () => {
        const existing = await store.get<{ items: Briefing[] }>("briefings");
        const merged = mergeBriefings(existing?.items ?? [], parsed.data);
        await store.put("briefings", { items: merged });
        return merged;
      },
      10000,
    );
    return json({
      briefings: items,
      delivery: deliveryStatus(
        await store.get<AlertSettings>("alert_settings"),
      ),
      actions_executed: false,
    });
  }
  return null;
}

function deliveryStatus(settings: AlertSettings | null) {
  const active =
    !!settings?.enabled && !!settings.notify && settings.briefings.enabled;
  return {
    active,
    lead_minutes: settings?.briefings.lead_minutes ?? null,
    only_when_tight: settings?.briefings.only_when_tight ?? null,
    reserve_percentage: settings?.briefings.reserve_percentage ?? null,
    ...(active
      ? {}
      : {
          guidance:
            "Server-side briefings are off. The owner can enable alerts and set a notification destination in the dashboard.",
        }),
  };
}
