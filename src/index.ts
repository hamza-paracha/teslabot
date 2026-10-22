import { registerPartner } from "./tesla/partner";
import type { Env } from "./types";
import { AppError } from "./types";
import { Store } from "./storage/database";
import {
  authorize,
  makeSession,
  rateLimit,
  sameOrigin,
  sessionCookie,
} from "./security/authorization";
import { authRoute, oauthCallback } from "./routes/auth";
import { vehicleRoute } from "./routes/vehicle";
import { json } from "./routes/http";
export async function route(r: Request, e: Env): Promise<Response> {
  const u = new URL(r.url),
    p = u.pathname;
  if (p === "/health" && r.method === "GET")
    return json({ service: "teslabot", status: "ok", mode: "read_only" });
  if (
    p === "/.well-known/appspecific/com.tesla.3p.public-key.pem" &&
    r.method === "GET"
  ) {
    const response = await e.ASSETS.fetch(r);
    const result = new Response(response.body, response);
    result.headers.set("Content-Type", "application/x-pem-file; charset=utf-8");
    return result;
  }
  if (
    (p === "/" || p === "/dashboard.js" || p === "/styles.css") &&
    r.method === "GET"
  )
    return e.ASSETS.fetch(r);
  if (!e.DB || !e.TOKEN_ENCRYPTION_KEY || !e.ADMIN_TOKEN || !e.APP_ORIGIN)
    throw new AppError("service_not_configured", 503);
  if (u.origin !== e.APP_ORIGIN)
    throw new AppError("invalid_service_origin", 403);
  const store = new Store(e);
  if (p === "/admin/session" && r.method === "POST") {
    sameOrigin(r, e);
    await rateLimit(e);
    if (
      r.headers.get("Content-Length") &&
      Number(r.headers.get("Content-Length")) > 1024
    )
      throw new AppError("request_too_large", 413);
    const role = await authorize(r, e);
    if (role !== "admin") throw new AppError("admin_required", 403);
    return jsonSession(await makeSession(e));
  }
  if (p === "/auth/callback" && r.method === "GET")
    return oauthCallback(r, e, store);
  const role = await authorize(r, e);
  await rateLimit(e);
  if (role === "reader" && !(r.method === "GET" && p.startsWith("/api/")))
    throw new AppError("read_only_token", 403);
  if (r.method !== "GET") {
    if (role !== "admin") throw new AppError("admin_required", 403);
    if (!r.headers.has("Authorization")) sameOrigin(r, e);
  }
  const authResponse = await authRoute(r, e, store);
  if (authResponse) return authResponse;
  if (p === "/admin/partner/register" && r.method === "POST")
    return json(await registerPartner(store));
  const vehicleResponse = await vehicleRoute(r, e, store);
  if (vehicleResponse) return vehicleResponse;
  if (p.includes("command") || p.includes("wake"))
    throw new AppError("vehicle_commands_disabled", 403);
  throw new AppError("not_found", 404);
}
function jsonSession(value: string) {
  const res = json({ authenticated: true });
  res.headers.set("Set-Cookie", sessionCookie(value));
  return res;
}
export default {
  async fetch(r: Request, e: Env): Promise<Response> {
    let response: Response;
    try {
      response = await route(r, e);
    } catch (error) {
      const err =
        error instanceof AppError ? error : new AppError("internal_error", 500);
      response = json({ error: { code: err.code } }, err.status);
      if (err.retryAfter) response.headers.set("Retry-After", err.retryAfter);
    }
    response = new Response(response.body, response);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("Strict-Transport-Security", "max-age=31536000");
    response.headers.set(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    return response;
  },
};
