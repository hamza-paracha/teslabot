import { platformFetch } from "./tesla/fetch";
import { AppError } from "./types";
import type { AlertSettings, Notification } from "./context/alerts";

// Header values must be printable ASCII; the full title is also kept in the body.
const header = (value: string) => value.replace(/[^\x20-\x7e]/g, "").trim();

export async function sendNotification(
  target: NonNullable<AlertSettings["notify"]>,
  notification: Notification,
  fetcher: typeof fetch = platformFetch,
) {
  const init: RequestInit =
    target.format === "ntfy"
      ? {
          method: "POST",
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            ...(header(notification.title)
              ? { Title: header(notification.title) }
              : {}),
            Tags: "car",
          },
          body: notification.message,
        }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: notification.kind,
            title: notification.title,
            message: notification.message,
            text: `${notification.title}\n${notification.message}`,
          }),
        };
  let response: Response;
  try {
    response = await fetcher(target.url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new AppError("notification_unreachable", 502);
  }
  await response.body?.cancel();
  if (!response.ok) throw new AppError("notification_rejected", 502);
}
