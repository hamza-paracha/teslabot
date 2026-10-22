import type { Env } from "../types";
import { AppError } from "../types";
import { Store } from "../storage/database";
import { hash, random } from "../security/crypto";
import { cookie, makeSession, sessionCookie } from "../security/authorization";
import {
  authorizationUrl,
  regions,
  tokenRequest,
  type Tokens,
} from "../tesla/auth";
import { json } from "./http";

const redirect = (path: string, headers: HeadersInit = {}) =>
  new Response(null, { status: 303, headers: { Location: path, ...headers } });
const browserCookie = (value: string, age = 600) =>
  `__Host-ev_oauth=${value}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}`;

// Public callback: the one-use, browser-bound OAuth transaction authorizes it.
export async function oauthCallback(
  r: Request,
  e: Env,
  store: Store,
): Promise<Response> {
  const u = new URL(r.url);
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
    if (!tokens.refresh_token) throw new AppError("missing_refresh_token", 502);
    await store.put("owner_tokens", tokens);
    await store.audit("oauth_connected");
  });
  const response = redirect("/");
  response.headers.append("Set-Cookie", browserCookie("", 0));
  response.headers.append("Set-Cookie", sessionCookie(await makeSession(e)));
  return response;
}

// Called only after the central administrator and same-origin checks.
export async function authRoute(
  r: Request,
  e: Env,
  store: Store,
): Promise<Response | null> {
  const p = new URL(r.url).pathname;
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
          e.DB.prepare("DELETE FROM records WHERE key IN (?,?,?,?,?,?,?)").bind(
            "owner_tokens",
            "selected",
            "vehicles",
            "summary",
            "previous_summary",
            "observation_history",
            "preferences",
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
  return null;
}
