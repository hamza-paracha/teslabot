import type { Env } from "../types";
import { AppError } from "../types";
import { equal, hash, random } from "./crypto";

// operator: installation administrator (ADMIN_TOKEN), owns account "".
// user: an invited driver signed in with Tesla.
// reader: an MCP credential, read-only except for planner state.
// telemetry: the telemetry relay, which may only post records.
export type Role = "operator" | "user" | "reader" | "telemetry";
export interface Principal {
  role: Role;
  account: string;
}
export const isOwner = (p: Principal) =>
  p.role === "operator" || p.role === "user";

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
export const MCP_TOKEN_PREFIX = "tbm_";

export async function authorize(r: Request, e: Env): Promise<Principal> {
  const authorization = r.headers.get("Authorization");
  if (authorization !== null) {
    const token = authorization.match(/^Bearer +(\S+)$/i)?.[1];
    if (!token) throw new AppError("unauthorized", 401);
    if (e.ADMIN_TOKEN && (await equal(token, e.ADMIN_TOKEN)))
      return { role: "operator", account: "" };
    if (e.MCP_TOKEN && (await equal(token, e.MCP_TOKEN)))
      return { role: "reader", account: "" };
    if (
      e.TELEMETRY_INGEST_TOKEN &&
      e.TELEMETRY_INGEST_TOKEN.length >= 32 &&
      (await equal(token, e.TELEMETRY_INGEST_TOKEN))
    )
      return { role: "telemetry", account: "" };
    if (token.startsWith(MCP_TOKEN_PREFIX) && token.length < 200) {
      const row = await e.DB.prepare(
        "SELECT t.account FROM mcp_tokens t JOIN accounts a ON a.id=t.account WHERE t.hash=? AND a.disabled=0",
      )
        .bind(await hash(token))
        .first<{ account: string }>();
      if (row) return { role: "reader", account: row.account };
    }
    throw new AppError("unauthorized", 401);
  }
  const session = cookie(r, "__Host-ev_session");
  if (session) {
    const found = await e.DB.prepare(
      "SELECT s.account, s.role FROM sessions s JOIN accounts a ON a.id=s.account WHERE s.hash=? AND s.expires>? AND a.disabled=0",
    )
      .bind(await hash(session), Date.now())
      .first<{ account: string; role: Role }>();
    if (found && (found.role === "operator" || found.role === "user"))
      return { role: found.role, account: found.account };
  }
  throw new AppError("unauthorized", 401);
}
export function sameOrigin(r: Request, e: Env) {
  if (r.headers.get("Origin") !== e.APP_ORIGIN)
    throw new AppError("invalid_origin", 403);
}
export async function makeSession(
  e: Env,
  account = "",
  role: "operator" | "user" = "operator",
) {
  const value = random();
  await e.DB.batch([
    e.DB.prepare("DELETE FROM sessions WHERE expires<?").bind(Date.now()),
    e.DB.prepare(
      "INSERT INTO sessions(hash,expires,account,role) VALUES(?,?,?,?)",
    ).bind(await hash(value), Date.now() + 3600000, account, role),
  ]);
  return value;
}
// Per-principal fixed-window limit; "public" covers unauthenticated entry points.
export async function rateLimit(e: Env, bucket = "public", limit = 60) {
  const minute = Math.floor(Date.now() / 60000);
  const row = await e.DB.prepare(
    "INSERT INTO locks(name,owner,expires) VALUES(?, '1', ?) ON CONFLICT(name) DO UPDATE SET owner=CASE WHEN locks.expires<>excluded.expires THEN '1' ELSE CAST(CAST(locks.owner AS INTEGER)+1 AS TEXT) END,expires=excluded.expires RETURNING owner",
  )
    .bind("http_rate:" + bucket, minute)
    .first<{ owner: string }>();
  if (Number(row?.owner) > limit) throw new AppError("rate_limited", 429);
}
