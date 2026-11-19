import type { Env } from "./types";
import { AppError } from "./types";
import { Store } from "./storage/database";
import { currentSummary } from "./routes/vehicle";
import { sendNotification } from "./notify";
import {
  defaultAlertState,
  departureBriefing,
  localParts,
  plugInReminder,
  type AlertSettings,
  type AlertState,
  type Briefing,
  type Notification,
} from "./context/alerts";
import type { Observation } from "./context/observations";

const CONCURRENCY = 5;

// Accounts that have alert settings saved. Key names are not encrypted; values are.
async function alertAccounts(e: Env) {
  const { results } = await e.DB.prepare(
    "SELECT key FROM records WHERE key='alert_settings' OR (key LIKE 'acct:%:alert_settings')",
  ).all<{ key: string }>();
  return results.map((row) =>
    row.key === "alert_settings"
      ? ""
      : row.key.slice(5, -":alert_settings".length),
  );
}

// Runs on the cron trigger. Each account is checked independently, a few at a
// time, so one slow Tesla read or failing destination affects only that driver.
export async function runScheduled(
  e: Env,
  ctx?: Pick<ExecutionContext, "waitUntil">,
  now = Date.now(),
  fetcher?: typeof fetch,
) {
  if (!e.DB || !e.TOKEN_ENCRYPTION_KEY) return [];
  const accounts = await alertAccounts(e);
  const results: Array<Record<string, unknown>> = [];
  for (let i = 0; i < accounts.length; i += CONCURRENCY) {
    const batch = accounts.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map((account) =>
        runAccountAlerts(e, new Store(e, ctx, account), now, fetcher),
      ),
    );
    settled.forEach((outcome, index) =>
      results.push(
        outcome.status === "fulfilled"
          ? { account: batch[index], ...outcome.value }
          : { account: batch[index], ran: false, reason: "failed" },
      ),
    );
  }
  return results;
}

export async function runAccountAlerts(
  e: Env,
  store: Store,
  now = Date.now(),
  fetcher?: typeof fetch,
): Promise<Record<string, unknown>> {
  try {
    return await store.locked("alerts", () => check(e, store, now, fetcher));
  } catch (error) {
    if (error instanceof AppError && error.code === "operation_in_progress")
      return { ran: false, reason: "already_running" };
    throw error;
  }
}

async function check(
  e: Env,
  store: Store,
  now: number,
  fetcher?: typeof fetch,
) {
  const [stored, active] = await Promise.all([
    store.getMany(["alert_settings", "alert_state", "briefings", "selected"]),
    e.DB.prepare("SELECT disabled FROM accounts WHERE id=?")
      .bind(store.account)
      .first<{ disabled: number }>(),
  ]);
  if (!active || active.disabled)
    return { ran: false, reason: "account_disabled" };
  const settings: AlertSettings | null = stored.alert_settings;
  if (!settings?.enabled || !settings.notify || !stored.selected)
    return { ran: false, reason: "alerts_disabled" };
  const state: AlertState = { ...defaultAlertState, ...stored.alert_state };
  const local = localParts(now, settings.time_zone);
  const items: Briefing[] = stored.briefings?.items ?? [];
  const lead = settings.briefings.lead_minutes * 60000;
  const plugDue =
    settings.plug_in.enabled &&
    local.hour >= settings.plug_in.local_hour &&
    state.plug_in_checked_date !== local.date;
  const due = settings.briefings.enabled
    ? items.filter((item) => {
        const at = Date.parse(item.departs_at);
        return (
          at - lead <= now &&
          now < at &&
          state.handled[item.event_id] !== item.departs_at
        );
      })
    : [];
  if (!plugDue && !due.length) return { ran: true, sent: [], checked: [] };
  let observation: Observation | null = null;
  try {
    observation = await currentSummary(e, store);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    const cached: Observation | null = stored.selected
      ? await store.get<Observation>("summary")
      : null;
    observation = cached?.vehicle.id === stored.selected.id ? cached : null;
  }
  const sent: string[] = [],
    checked: string[] = [];
  const deliver = async (notification: Notification | null) => {
    if (!notification) return true;
    try {
      await sendNotification(settings.notify!, notification, fetcher);
      sent.push(notification.kind);
      state.last_sent_at = new Date(now).toISOString();
      state.last_error = null;
      await store.audit("alert_sent");
      return true;
    } catch (error) {
      state.last_error =
        error instanceof AppError ? error.code : "notification_failed";
      return false;
    }
  };
  if (plugDue && (await deliver(plugInReminder(observation, settings, now)))) {
    state.plug_in_checked_date = local.date;
    checked.push("plug_in");
  }
  for (const item of due)
    if (await deliver(departureBriefing(item, observation, settings, now))) {
      state.handled[item.event_id] = item.departs_at;
      checked.push("briefing:" + item.event_id);
    }
  const live = new Set(items.map((item) => item.event_id));
  state.handled = Object.fromEntries(
    Object.entries(state.handled).filter(([id]) => live.has(id)),
  );
  await store.put("alert_state", state);
  return { ran: true, sent, checked };
}
