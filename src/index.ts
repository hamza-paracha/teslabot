import { registerPartner } from "./tesla/partner";
import type { Env } from "./types";
import { AppError } from "./types";
import { Store } from "./storage/database";
import {
  authorize,
  isOwner,
  makeSession,
  rateLimit,
  sameOrigin,
  sessionCookie,
  type Principal,
} from "./security/authorization";
import { authRoute, oauthCallback, publicAuthRoute } from "./routes/auth";
import { vehicleRoute } from "./routes/vehicle";
import { tripRoute } from "./routes/trips";
import { alertRoute } from "./routes/alerts";
import { accountRoute } from "./routes/accounts";
import { telemetryRoute } from "./routes/telemetry";
import { runScheduled } from "./scheduled";
import { createServer } from "../mcp/src/server";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { json } from "./routes/http";
import { recovery } from "./routes/recovery";
// The MCP token may write only planning state; it can never reach vehicle,
// account or administrative mutations.
const readerWritable = new Set([
  "/api/trips",
  "/api/trips/outcome",
  "/api/briefings",
]);
export async function route(
  r: Request,
  e: Env,
  ctx?: ExecutionContext,
  internal?: Principal,
): Promise<Response> {
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
  if (p === "/admin/session" && r.method === "POST") {
    sameOrigin(r, e);
    if (!r.headers.has("Authorization"))
      throw new AppError("unauthorized", 401);
    await rateLimit(e);
    if (
      r.headers.get("Content-Length") &&
      Number(r.headers.get("Content-Length")) > 1024
    )
      throw new AppError("request_too_large", 413);
    const principal = await authorize(r, e);
    if (principal.role !== "operator")
      throw new AppError("admin_required", 403);
    return jsonSession(await makeSession(e, "", "operator"));
  }
  if (p === "/auth/callback" && r.method === "GET") {
    await rateLimit(e);
    return oauthCallback(r, e, ctx);
  }
  if (p === "/auth/signin" || p === "/auth/signup") {
    await rateLimit(e);
    const response = await publicAuthRoute(r, e);
    if (response) return response;
  }
  // In-process MCP tool calls carry the principal that /mcp already authorized.
  const principal = internal ?? (await authorize(r, e));
  if (!internal) await rateLimit(e, "acct:" + principal.account, 120);
  const store = new Store(e, ctx, principal.account);
  if (p === "/mcp") return mcp(r, e, principal, ctx);
  if (principal.role === "telemetry") {
    const response = await telemetryRoute(r, e, store, principal);
    if (response) return response;
    throw new AppError("telemetry_credential_required", 403);
  }
  const plannerWrite = r.method === "POST" && readerWritable.has(p);
  if (
    principal.role === "reader" &&
    !((r.method === "GET" && p.startsWith("/api/")) || plannerWrite)
  )
    throw new AppError("read_only_token", 403);
  if (r.method !== "GET") {
    if (!isOwner(principal) && !plannerWrite)
      throw new AppError("admin_required", 403);
    if (!r.headers.has("Authorization")) sameOrigin(r, e);
  }
  const authResponse = await authRoute(r, e, store, principal);
  if (authResponse) return authResponse;
  if (p === "/admin/partner/register" && r.method === "POST") {
    if (principal.role !== "operator")
      throw new AppError("operator_required", 403);
    return json(await registerPartner(store));
  }
  const vehicleResponse =
    (await accountRoute(r, e, store, principal, ctx)) ??
    (await telemetryRoute(r, e, store, principal)) ??
    (await vehicleRoute(r, e, store)) ??
    (await tripRoute(r, e, store)) ??
    (await alertRoute(r, e, store));
  if (vehicleResponse) return vehicleResponse;
  if (p.includes("command") || p.includes("wake"))
    throw new AppError("vehicle_commands_disabled", 403);
  throw new AppError("not_found", 404);
}
// Hosted Streamable HTTP MCP. Requires a bearer credential (never a browser
// cookie). Tool calls are served in-process as a reader principal for the
// caller's own account, whatever credential opened the session.
async function mcp(
  r: Request,
  e: Env,
  principal: Principal,
  ctx?: ExecutionContext,
) {
  if (!r.headers.has("Authorization")) throw new AppError("unauthorized", 401);
  if (principal.role === "telemetry")
    throw new AppError("read_only_token", 403);
  const reader: Principal = { role: "reader", account: principal.account };
  // Workers rejects redirect "error" in the Request constructor; an in-process
  // call never follows redirects anyway.
  // Errors become the same JSON (code and next steps) an HTTP caller receives.
  const fetcher: typeof fetch = async (input, init) => {
    try {
      return await route(
        new Request(input, { ...init, redirect: "manual" }),
        e,
        ctx,
        reader,
      );
    } catch (error) {
      return errorResponse(error, e);
    }
  };
  // createServer requires a credential-shaped token; in-process calls never
  // check it because the principal is passed directly.
  const handler = createMcpHandler(
    () => createServer(e.APP_ORIGIN, "in-process-".padEnd(40, "x"), fetcher),
    { legacy: "stateless", maxRequestBodySize: 65536 },
  );
  return handler.fetch(r);
}
function errorResponse(error: unknown, e: Env) {
  const err =
    error instanceof AppError ? error : new AppError("internal_error", 500);
  const response = json(
    { error: { code: err.code, ...recovery(err.code, e.APP_ORIGIN) } },
    err.status,
  );
  if (err.retryAfter) response.headers.set("Retry-After", err.retryAfter);
  return response;
}
function jsonSession(value: string) {
  const res = json({ authenticated: true });
  res.headers.set("Set-Cookie", sessionCookie(value));
  return res;
}
export default {
  async scheduled(
    _controller: ScheduledController,
    e: Env,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(runScheduled(e, ctx));
  },
  async fetch(r: Request, e: Env, ctx?: ExecutionContext): Promise<Response> {
    let response: Response;
    try {
      response = await route(r, e, ctx);
    } catch (error) {
      const u = new URL(r.url);
      if (
        [
          "/auth/callback",
          "/auth/login",
          "/auth/signin",
          "/auth/signup",
        ].includes(u.pathname) &&
        r.headers.get("Accept")?.includes("text/html")
      ) {
        const code = error instanceof AppError ? error.code : "internal_error";
        // Remove the authorization code/state from the browser's address bar.
        // Only our stable application code is included in the landing URL.
        response = new Response(null, {
          status: 303,
          headers: { Location: "/?oauth_error=" + encodeURIComponent(code) },
        });
        if (error instanceof AppError && error.retryAfter)
          response.headers.set("Retry-After", error.retryAfter);
      } else response = errorResponse(error, e);
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
