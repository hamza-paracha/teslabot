import { registerPartner } from "./tesla/partner";
import type { Env } from "./types";
import { AppError } from "./types";
import { Store } from "./storage/database";
import { hash, random } from "./security/crypto";
import {
  authorize,
  cookie,
  makeSession,
  rateLimit,
  sameOrigin,
  sessionCookie,
} from "./security/authorization";
import {
  authorizationUrl,
  regions,
  tokenRequest,
  type Tokens,
} from "./tesla/auth";
import { vehicleRoute } from "./routes/vehicle";
import { json } from "./routes/http";
const redirect = (path: string, headers: HeadersInit = {}) =>
  new Response(null, { status: 303, headers: { Location: path, ...headers } });
const browserCookie = (v: string, age = 600) =>
  `__Host-ev_oauth=${v}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}`;
export async function route(r: Request, e: Env): Promise<Response> {
  const u = new URL(r.url),
    p = u.pathname;
  if (p === "/health" && r.method === "GET")
    return json({ service: "EVIntelligence", status: "ok", mode: "read_only" });
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
  if (p === "/auth/callback" && r.method === "GET") {
    const state = u.searchParams.get("state"),
      browser = cookie(r, "__Host-ev_oauth");
    if (!state || !browser) throw new AppError("invalid_oauth_state");
    const transaction = await e.DB.prepare(
      "DELETE FROM oauth_states WHERE hash=? AND browser_hash=? AND expires>? RETURNING hash",
    )
      .bind(await hash(state), await hash(browser), Date.now())
      .first();
    if (!transaction) throw new AppError("expired_or_replayed_state");
    if (u.searchParams.has("error")) throw new AppError("oauth_consent_denied");
    const code = u.searchParams.get("code");
    if (!code || code.length > 4096)
      throw new AppError("missing_authorization_code");
    await store.locked("account", async () => {
      if (await store.get("owner_tokens"))
        throw new AppError("disconnect_before_reconnecting", 409);
      const tokens = await tokenRequest({
        grant_type: "authorization_code",
        client_id: e.TESLA_CLIENT_ID!,
        client_secret: e.TESLA_CLIENT_SECRET!,
        code,
        audience: regions[e.TESLA_REGION],
        redirect_uri: e.APP_ORIGIN + "/auth/callback",
      });
      if (!tokens.refresh_token)
        throw new AppError("missing_refresh_token", 502);
      await store.put("owner_tokens", tokens);
      await store.audit("oauth_connected");
    });
    const response = redirect("/");
    response.headers.append("Set-Cookie", browserCookie("", 0));
    response.headers.append("Set-Cookie", sessionCookie(await makeSession(e)));
    return response;
  }
  const role = await authorize(r, e);
  await rateLimit(e);
  if (role === "reader" && !(r.method === "GET" && p.startsWith("/api/")))
    throw new AppError("read_only_token", 403);
  if (r.method !== "GET") {
    if (role !== "admin") throw new AppError("admin_required", 403);
    if (!r.headers.has("Authorization")) sameOrigin(r, e);
  }
  if (p === "/auth/status" && r.method === "GET") {
    const tokens = await store.get<Tokens>("owner_tokens"),
      selected = await store.get<{ id: string }>("selected");
    const usage = await e.DB.prepare(
      "SELECT category,SUM(count) AS requests,SUM(estimated_usd) AS estimated_usd FROM usage WHERE month=? GROUP BY category",
    )
      .bind(new Date().toISOString().slice(0, 7))
      .all();
    return json({
      configured: !!(e.TESLA_CLIENT_ID && e.TESLA_CLIENT_SECRET),
      connected: !!tokens,
      vehicle_selected: !!selected,
      partner: (await store.get("partner_status")) ?? "unverified",
      virtual_key: "unverified",
      commands_enabled: false,
      location_enabled: e.ENABLE_LOCATION === "true",
      usage: usage.results,
    });
  }
  if (p === "/auth/login" && r.method === "GET") {
    if (!e.TESLA_CLIENT_ID || !e.TESLA_CLIENT_SECRET)
      throw new AppError("tesla_credentials_missing", 503);
    if (await store.get("owner_tokens"))
      throw new AppError("disconnect_before_reconnecting", 409);
    const state = random(),
      browser = random();
    await e.DB.prepare("DELETE FROM oauth_states WHERE expires<?")
      .bind(Date.now())
      .run();
    await e.DB.prepare(
      "INSERT INTO oauth_states(hash,browser_hash,expires) VALUES(?,?,?)",
    )
      .bind(await hash(state), await hash(browser), Date.now() + 600000)
      .run();
    return redirect(authorizationUrl(e, state), {
      "Set-Cookie": browserCookie(browser),
    });
  }
  if (p === "/auth/disconnect" && r.method === "POST") {
    await store.locked("vehicle", () =>
      store.locked("account", async () => {
        await e.DB.batch([
          e.DB.prepare("DELETE FROM records WHERE key IN (?,?,?,?,?)").bind(
            "owner_tokens",
            "selected",
            "vehicles",
            "summary",
            "previous_summary",
          ),
          e.DB.prepare("DELETE FROM oauth_states"),
          e.DB.prepare("DELETE FROM sessions"),
        ]);
      }),
    );
    await store.audit("oauth_disconnected");
    return json({
      disconnected: true,
      tesla_consent_revocation:
        "Use Tesla account third-party app management to revoke server-side consent.",
    });
  }
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
