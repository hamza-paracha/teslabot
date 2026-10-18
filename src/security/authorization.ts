import type { Env } from "../types";
import { AppError } from "../types";
import { equal, hash, random } from "./crypto";
export function cookie(r: Request, name: string) {
  return (
    r.headers
      .get("Cookie")
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(name + "="))
      ?.slice(name.length + 1) ?? ""
  );
}
export const sessionCookie = (value: string, age = 3600) =>
  `__Host-ev_session=${value}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}`;
export async function authorize(
  r: Request,
  e: Env,
): Promise<"admin" | "reader"> {
  const token = r.headers.get("Authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (token && e.ADMIN_TOKEN && (await equal(token, e.ADMIN_TOKEN)))
    return "admin";
  if (token && e.MCP_TOKEN && (await equal(token, e.MCP_TOKEN)))
    return "reader";
  const session = cookie(r, "__Host-ev_session");
  if (session) {
    const found = await e.DB.prepare(
      "SELECT hash FROM sessions WHERE hash=? AND expires>?",
    )
      .bind(await hash(session), Date.now())
      .first();
    if (found) return "admin";
  }
  throw new AppError("unauthorized", 401);
}
export function sameOrigin(r: Request, e: Env) {
  if (r.headers.get("Origin") !== e.APP_ORIGIN)
    throw new AppError("invalid_origin", 403);
}
export async function makeSession(e: Env) {
  const value = random();
  await e.DB.prepare("DELETE FROM sessions WHERE expires<?")
    .bind(Date.now())
    .run();
  await e.DB.prepare("INSERT INTO sessions(hash,expires) VALUES(?,?)")
    .bind(await hash(value), Date.now() + 3600000)
    .run();
  return value;
}
export async function rateLimit(e: Env) {
  const minute = Math.floor(Date.now() / 60000);
  const row = await e.DB.prepare(
    "INSERT INTO locks(name,owner,expires) VALUES('http_rate', '1', ?) ON CONFLICT(name) DO UPDATE SET owner=CASE WHEN locks.expires<>excluded.expires THEN '1' ELSE CAST(CAST(locks.owner AS INTEGER)+1 AS TEXT) END,expires=excluded.expires RETURNING owner",
  )
    .bind(minute)
    .first<{ owner: string }>();
  if (Number(row?.owner) > 60) throw new AppError("rate_limited", 429);
}
