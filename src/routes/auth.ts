import type { Env } from "../types";
import { AppError } from "../types";
import { Store } from "../storage/database";
import { hash, random, seal } from "../security/crypto";
import {
  cookie,
  makeSession,
  sessionCookie,
  type Principal,
} from "../security/authorization";
import {
  authorizationUrl,
  regions,
  scopes,
  teslaSubject,
  tokenRequest,
  type Tokens,
} from "../tesla/auth";
import { json } from "./http";
import { clearVehicleData, vehicleAccess } from "../tesla/vehicles";

type Purpose = "connect" | "reconnect" | "signup" | "signin";
const redirect = (path: string, headers: HeadersInit = {}) =>
  new Response(null, { status: 303, headers: { Location: path, ...headers } });
const browserCookie = (value: string, age = 600) =>
  `__Host-ev_oauth=${value}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}`;
export const newAccountId = () => random().replace(/-/g, "").slice(0, 24);

const linkedAccount = (e: Env, subjectHash: string) =>
  e.DB.prepare("SELECT id, disabled FROM accounts WHERE tesla_sub_hash=?")
    .bind(subjectHash)
    .first<{ id: string; disabled: number }>();

// Begin a browser-bound Tesla authorization. connect/reconnect belong to an
// existing account; signup carries an invite and signin carries nothing.
async function begin(
  e: Env,
  purpose: Purpose,
  account: Principal | null,
  inviteHash: string | null = null,
) {
  const state = random(),
    browser = random();
  await e.DB.batch([
    e.DB.prepare("DELETE FROM oauth_states WHERE expires<?").bind(Date.now()),
    e.DB.prepare(
      "INSERT INTO oauth_states(hash,browser_hash,expires,purpose,account,role,invite_hash) VALUES(?,?,?,?,?,?,?)",
    ).bind(
      await hash(state),
      await hash(browser),
      Date.now() + 600000,
      purpose,
      account?.account ?? null,
      account?.role ?? null,
      inviteHash,
    ),
  ]);
  return { url: authorizationUrl(e, state), browser };
}

// Public routes: anyone can start Tesla sign-in, but only an existing account or
// a valid invite can complete it.
export async function publicAuthRoute(
  r: Request,
  e: Env,
): Promise<Response | null> {
  const u = new URL(r.url);
  if (r.method !== "GET") return null;
  if (u.pathname !== "/auth/signin" && u.pathname !== "/auth/signup")
    return null;
  if (!e.TESLA_CLIENT_ID || !e.TESLA_CLIENT_SECRET)
    throw new AppError("tesla_credentials_missing", 503);
  let inviteHash: string | null = null;
  if (u.pathname === "/auth/signup") {
    const code = u.searchParams.get("invite") ?? "";
    if (!/^[a-f0-9]{32,64}$/.test(code)) throw new AppError("invite_invalid");
    inviteHash = await hash(code);
    const invite = await e.DB.prepare(
      "SELECT hash FROM invites WHERE hash=? AND used_at IS NULL AND expires>?",
    )
      .bind(inviteHash, Date.now())
      .first();
    if (!invite) throw new AppError("invite_invalid", 403);
  }
  const { url, browser } = await begin(
    e,
    inviteHash ? "signup" : "signin",
    null,
    inviteHash,
  );
  return redirect(url, { "Set-Cookie": browserCookie(browser) });
}

// Public callback: the one-use, browser-bound OAuth transaction authorizes it.
export async function oauthCallback(
  r: Request,
  e: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const u = new URL(r.url);
  const state = u.searchParams.get("state"),
    browser = cookie(r, "__Host-ev_oauth");
  if (!state || !browser) throw new AppError("invalid_oauth_state");
  const transaction = await e.DB.prepare(
    "DELETE FROM oauth_states WHERE hash=? AND browser_hash=? AND expires>? RETURNING purpose, account, role, invite_hash",
  )
    .bind(await hash(state), await hash(browser), Date.now())
    .first<{
      purpose: Purpose;
      account: string | null;
      role: "operator" | "user" | null;
      invite_hash: string | null;
    }>();
  if (!transaction) throw new AppError("expired_or_replayed_state");
  if (u.searchParams.has("error")) throw new AppError("oauth_consent_denied");
  const code = u.searchParams.get("code");
  if (!code || code.length > 4096)
    throw new AppError("missing_authorization_code");
  // Fail before exchanging the code: a plain connect never replaces an account.
  if (
    transaction.purpose === "connect" &&
    (await new Store(e, ctx, transaction.account ?? "").get("owner_tokens"))
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
  if (!tokens.refresh_token) throw new AppError("missing_refresh_token", 502);
  const subject = teslaSubject(tokens, e);
  const subjectHash = subject ? await hash("tesla:" + subject) : null;
  const linked = subjectHash ? await linkedAccount(e, subjectHash) : null;
  let account: string, role: "operator" | "user";
  if (
    transaction.purpose === "connect" ||
    transaction.purpose === "reconnect"
  ) {
    account = transaction.account ?? "";
    role = transaction.role ?? "operator";
    if (linked && linked.id !== account)
      throw new AppError("tesla_account_already_linked", 409);
    await connect(
      e,
      new Store(e, ctx, account),
      tokens,
      transaction.purpose,
      subjectHash,
    );
  } else {
    if (!subjectHash) throw new AppError("tesla_identity_unavailable", 502);
    const inviteHash =
      transaction.purpose === "signup" ? transaction.invite_hash : null;
    if (!linked && !inviteHash) throw new AppError("invite_required", 403);
    const created =
      !linked && inviteHash
        ? await signUp(e, ctx, inviteHash, subjectHash, tokens)
        : null;
    if (created) {
      account = created;
    } else {
      // A concurrent signup may have linked this identity after the first lookup.
      const existing = linked ?? (await linkedAccount(e, subjectHash));
      if (!existing) throw new AppError("invite_invalid", 403);
      if (existing.disabled) throw new AppError("account_disabled", 403);
      account = existing.id;
      await signIn(new Store(e, ctx, account), tokens);
    }
    role = "user";
  }
  const session = await makeSession(e, account, role);
  const response = redirect("/?oauth=connected");
  response.headers.append("Set-Cookie", browserCookie("", 0));
  response.headers.append("Set-Cookie", sessionCookie(session));
  return response;
}

async function signUp(
  e: Env,
  ctx: ExecutionContext | undefined,
  inviteHash: string,
  subjectHash: string,
  tokens: Tokens,
) {
  const account = newAccountId();
  const store = new Store(e, ctx, account);
  const key = store.key("owner_tokens");
  const value = await seal(tokens, e.TOKEN_ENCRYPTION_KEY!, key);
  const now = Date.now();
  const [created] = await e.DB.batch([
    e.DB.prepare(
      "INSERT INTO accounts(id,tesla_sub_hash,label,created) SELECT ?,?,label,? FROM invites WHERE hash=? AND used_at IS NULL AND expires>? ON CONFLICT(tesla_sub_hash) DO NOTHING",
    ).bind(account, subjectHash, now, inviteHash, now),
    e.DB.prepare(
      "UPDATE invites SET used_at=?, account=? WHERE hash=? AND used_at IS NULL AND expires>? AND EXISTS (SELECT 1 FROM accounts WHERE id=?)",
    ).bind(now, account, inviteHash, now, account),
    e.DB.prepare(
      "INSERT INTO records(key,value) SELECT ?,? FROM invites WHERE hash=? AND account=? AND used_at=?",
    ).bind(key, value, inviteHash, account, now),
  ]);
  if (!created.meta.changes) return null;
  await store.audit("account_created");
  return account;
}

async function connect(
  e: Env,
  store: Store,
  tokens: Tokens,
  purpose: "connect" | "reconnect",
  subjectHash: string | null,
) {
  await store.locked("vehicle", () =>
    store.locked("account", async () => {
      const account = await e.DB.prepare(
        "SELECT disabled FROM accounts WHERE id=?",
      )
        .bind(store.account)
        .first<{ disabled: number }>();
      if (!account || account.disabled)
        throw new AppError("account_disabled", 403);
      if (purpose !== "reconnect" && (await store.get("owner_tokens")))
        throw new AppError("disconnect_before_reconnecting", 409);
      // Commit the replacement and cleanup together, only after a valid token exchange.
      await store.putMany({ owner_tokens: tokens }, [
        clearVehicleData(store),
        store.deleteKeys(["preferences", "alert_settings"]),
        e.DB.prepare("DELETE FROM sessions WHERE account=?").bind(
          store.account,
        ),
        e.DB.prepare("DELETE FROM oauth_states WHERE account=?").bind(
          store.account,
        ),
        e.DB.prepare("DELETE FROM telemetry_vehicles WHERE account=?").bind(
          store.account,
        ),
        ...(subjectHash
          ? [
              e.DB.prepare(
                "UPDATE accounts SET tesla_sub_hash=? WHERE id=?",
              ).bind(subjectHash, store.account),
            ]
          : []),
      ]);
      await store.audit("oauth_connected");
    }),
  );
}

// Same Tesla identity signing in again: refresh the grant, keep the car's data.
async function signIn(store: Store, tokens: Tokens) {
  await store.locked(
    "account",
    async () => {
      await store.put("owner_tokens", tokens);
      await store.audit("signed_in");
    },
    10000,
  );
}

// Called only after the central owner and same-origin checks.
export async function authRoute(
  r: Request,
  e: Env,
  store: Store,
  principal: Principal,
): Promise<Response | null> {
  const p = new URL(r.url).pathname;
  if (p === "/auth/status" && r.method === "GET") {
    const stored = await store.getMany(["owner_tokens", "selected"]);
    const tokens: Tokens | null = stored.owner_tokens;
    const usage = await e.DB.prepare(
      "SELECT category,SUM(count) AS requests,SUM(estimated_usd) AS estimated_usd FROM usage WHERE account=? AND month=? GROUP BY category",
    )
      .bind(store.account, new Date().toISOString().slice(0, 7))
      .all();
    return json({
      role: principal.role,
      configured: !!(e.TESLA_CLIENT_ID && e.TESLA_CLIENT_SECRET),
      connected: !!tokens,
      vehicle_selected: !!stored.selected,
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
      partner:
        principal.role === "operator"
          ? ((await store.get("partner_status")) ?? "unverified")
          : undefined,
      virtual_key: "unverified",
      commands_enabled: false,
      location_enabled: e.ENABLE_LOCATION === "true",
      telemetry_available: !!(e.TELEMETRY && e.TELEMETRY_HOSTNAME),
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
    const { url, browser } = await begin(
      e,
      p === "/auth/reconnect" ? "reconnect" : "connect",
      principal,
    );
    if (p === "/auth/reconnect") {
      const response = json({ authorization_url: url });
      response.headers.set("Set-Cookie", browserCookie(browser));
      return response;
    }
    return redirect(url, { "Set-Cookie": browserCookie(browser) });
  }
  if (p === "/auth/disconnect" && r.method === "POST") {
    await store.locked("vehicle", () =>
      store.locked("account", async () => {
        await e.DB.batch([
          clearVehicleData(store),
          store.deleteKeys(["owner_tokens", "preferences", "alert_settings"]),
          e.DB.prepare("DELETE FROM oauth_states WHERE account=?").bind(
            store.account,
          ),
          e.DB.prepare("DELETE FROM sessions WHERE account=?").bind(
            store.account,
          ),
          e.DB.prepare("DELETE FROM telemetry_vehicles WHERE account=?").bind(
            store.account,
          ),
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
