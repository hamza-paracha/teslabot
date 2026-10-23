import type { Env } from "../types";
import { AppError } from "../types";
import { Store } from "../storage/database";
import { hash, random } from "../security/crypto";
import { cookie, makeSession, sessionCookie } from "../security/authorization";
import {
  authorizationUrl,
  regions,
  scopes,
  tokenRequest,
  type Tokens,
} from "../tesla/auth";
import { json } from "./http";
import { clearVehicleData, vehicleAccess } from "../tesla/vehicles";

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
  const session = await store.locked("vehicle", () =>
    store.locked("account", async () => {
      // Consume state under the same locks as disconnect/replacement. A completed
      // disconnect must invalidate every pending sign-in, including callbacks.
      const transaction = await e.DB.prepare(
        "DELETE FROM oauth_states WHERE hash=? AND browser_hash=? AND expires>? RETURNING purpose",
      )
        .bind(await hash(state), await hash(browser), Date.now())
        .first<{ purpose: string }>();
      if (!transaction) throw new AppError("expired_or_replayed_state");
      if (u.searchParams.has("error"))
        throw new AppError("oauth_consent_denied");
      const code = u.searchParams.get("code");
      if (!code || code.length > 4096)
        throw new AppError("missing_authorization_code");
      if (
        transaction.purpose !== "reconnect" &&
        (await store.get("owner_tokens"))
      )
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
      // Commit the replacement and cleanup together, only after a valid token exchange.
      await store.putMany({ owner_tokens: tokens }, [
        clearVehicleData(store),
        e.DB.prepare("DELETE FROM records WHERE key='preferences'"),
        e.DB.prepare("DELETE FROM sessions"),
        e.DB.prepare("DELETE FROM oauth_states"),
      ]);
      await store.audit("oauth_connected");
      return makeSession(e);
    }),
  );
  const response = redirect("/?oauth=connected");
  response.headers.append("Set-Cookie", browserCookie("", 0));
  response.headers.append("Set-Cookie", sessionCookie(session));
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
      vehicle_access: await vehicleAccess(store),
      authorization: {
        requested_scopes: scopes(e),
        vehicle_information:
          tokens?.scope === undefined
            ? "unknown"
            : tokens.scope.split(/\s+/).includes("vehicle_device_data")
              ? "granted"
              : "missing",
      },
      partner: (await store.get("partner_status")) ?? "unverified",
      virtual_key: "unverified",
      commands_enabled: false,
      location_enabled: e.ENABLE_LOCATION === "true",
      usage: usage.results,
    });
  }
  if (
    (p === "/auth/login" && r.method === "GET") ||
    (p === "/auth/reconnect" && r.method === "POST")
  ) {
    if (!e.TESLA_CLIENT_ID || !e.TESLA_CLIENT_SECRET)
      throw new AppError("tesla_credentials_missing", 503);
    if (p === "/auth/login" && (await store.get("owner_tokens")))
      throw new AppError("disconnect_before_reconnecting", 409);
    const state = random(),
      browser = random();
    await e.DB.prepare("DELETE FROM oauth_states WHERE expires<?")
      .bind(Date.now())
      .run();
    await e.DB.prepare(
      "INSERT INTO oauth_states(hash,browser_hash,expires,purpose) VALUES(?,?,?,?)",
    )
      .bind(
        await hash(state),
        await hash(browser),
        Date.now() + 600000,
        p === "/auth/reconnect" ? "reconnect" : "connect",
      )
      .run();
    if (p === "/auth/reconnect") {
      const response = json({ authorization_url: authorizationUrl(e, state) });
      response.headers.set("Set-Cookie", browserCookie(browser));
      return response;
    }
    return redirect(authorizationUrl(e, state), {
      "Set-Cookie": browserCookie(browser),
    });
  }
  if (p === "/auth/disconnect" && r.method === "POST") {
    await store.locked("vehicle", () =>
      store.locked("account", async () => {
        await e.DB.batch([
          clearVehicleData(store),
          e.DB.prepare("DELETE FROM records WHERE key IN (?,?)").bind(
            "owner_tokens",
            "preferences",
          ),
          e.DB.prepare("DELETE FROM oauth_states"),
          e.DB.prepare("DELETE FROM sessions"),
        ]);
      }),
    );
    await store.audit("oauth_disconnected");
    const response = json({
      disconnected: true,
      tesla_consent_revocation:
        "Use Tesla account third-party app management to revoke server-side consent.",
    });
    response.headers.append("Set-Cookie", sessionCookie("", 0));
    response.headers.append("Set-Cookie", browserCookie("", 0));
    return response;
  }
  return null;
}
