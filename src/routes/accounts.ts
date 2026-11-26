import { z } from "zod";
import type { Env } from "../types";
import { AppError } from "../types";
import { Store } from "../storage/database";
import { hash, random } from "../security/crypto";
import { MCP_TOKEN_PREFIX, type Principal } from "../security/authorization";
import { json, readJson } from "./http";
import { removeTelemetry } from "./telemetry";

const MCP_TOKEN_LIMIT = 10;
const label = z
  .string()
  .transform((value) =>
    value
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim()
      .slice(0, 80),
  )
  .default("");
const inviteSchema = z
  .object({ label, days: z.number().int().min(1).max(30).default(14) })
  .strict();
const idSchema = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const accountSchema = z
  .object({ id: z.string().regex(/^[a-f0-9]{24}$/) })
  .strict();

// Remove an invited account and everything stored for it. Tesla-side telemetry
// configuration is removed first while the account's token still exists.
export async function deleteAccount(
  e: Env,
  account: string,
  ctx?: ExecutionContext,
) {
  if (!account) throw new AppError("owner_account_protected", 403);
  const store = new Store(e, ctx, account);
  await removeTelemetry(e, store);
  await e.DB.batch([
    store.deleteAll(),
    e.DB.prepare("DELETE FROM sessions WHERE account=?").bind(account),
    e.DB.prepare("DELETE FROM mcp_tokens WHERE account=?").bind(account),
    e.DB.prepare("DELETE FROM oauth_states WHERE account=?").bind(account),
    e.DB.prepare("DELETE FROM telemetry_vehicles WHERE account=?").bind(
      account,
    ),
    e.DB.prepare("DELETE FROM locks WHERE substr(name,1,?)=?").bind(
      store.prefix.length,
      store.prefix,
    ),
    e.DB.prepare("DELETE FROM accounts WHERE id=?").bind(account),
  ]);
  await store.audit("account_deleted");
}

export async function accountRoute(
  r: Request,
  e: Env,
  store: Store,
  principal: Principal,
  ctx?: ExecutionContext,
): Promise<Response | null> {
  const p = new URL(r.url).pathname;
  const operator = principal.role === "operator";
  if (p.startsWith("/admin/invites") || p.startsWith("/admin/accounts")) {
    if (!operator) throw new AppError("operator_required", 403);
  }
  if (p === "/admin/invites" && r.method === "POST") {
    const parsed = inviteSchema.safeParse(await readJson(r));
    if (!parsed.success) throw new AppError("invalid_invite");
    const code = random().replace(/-/g, "").slice(0, 40);
    const expires = Date.now() + parsed.data.days * 86400000;
    await e.DB.prepare(
      "INSERT INTO invites(hash,label,created,expires) VALUES(?,?,?,?)",
    )
      .bind(await hash(code), parsed.data.label, Date.now(), expires)
      .run();
    await store.audit("invite_created");
    // The code is shown once; only its hash is stored.
    return json({
      invite_url: `${e.APP_ORIGIN}/?invite=${code}`,
      expires_at: new Date(expires).toISOString(),
    });
  }
  if (p === "/admin/invites" && r.method === "GET") {
    const { results } = await e.DB.prepare(
      "SELECT hash AS id,label,created,expires,used_at,account FROM invites ORDER BY created DESC LIMIT 200",
    ).all<{
      id: string;
      label: string;
      created: number;
      expires: number;
      used_at: number | null;
      account: string | null;
    }>();
    return json({
      invites: results.map((item) => ({
        ...item,
        status: item.used_at
          ? "used"
          : item.expires <= Date.now()
            ? "expired"
            : "open",
      })),
    });
  }
  if (p === "/admin/invites/revoke" && r.method === "POST") {
    const parsed = idSchema.safeParse(await readJson(r));
    if (!parsed.success) throw new AppError("invalid_invite");
    await e.DB.prepare("DELETE FROM invites WHERE hash=? AND used_at IS NULL")
      .bind(parsed.data.id)
      .run();
    return json({ revoked: true });
  }
  if (p === "/admin/accounts" && r.method === "GET") {
    const { results } = await e.DB.prepare(
      "SELECT a.id,a.label,a.created,a.disabled,(SELECT COUNT(*) FROM records r WHERE r.key = 'acct:' || a.id || ':owner_tokens' OR (a.id = '' AND r.key = 'owner_tokens')) AS connected,(SELECT COUNT(*) FROM telemetry_vehicles t WHERE t.account=a.id) AS telemetry FROM accounts a ORDER BY a.created",
    ).all<{
      id: string;
      label: string;
      created: number;
      disabled: number;
      connected: number;
      telemetry: number;
    }>();
    return json({
      accounts: results.map((item) => ({
        id: item.id,
        owner: item.id === "",
        label: item.label,
        created: item.created,
        disabled: !!item.disabled,
        connected: !!item.connected,
        telemetry: !!item.telemetry,
      })),
    });
  }
  if (p === "/admin/accounts/disable" && r.method === "POST") {
    const parsed = accountSchema
      .extend({ disabled: z.boolean() })
      .safeParse(await readJson(r));
    if (!parsed.success) throw new AppError("invalid_account");
    const result = await e.DB.batch([
      e.DB.prepare("UPDATE accounts SET disabled=? WHERE id=?").bind(
        parsed.data.disabled ? 1 : 0,
        parsed.data.id,
      ),
      // Disabling ends access immediately; sessions are not restored on re-enable.
      e.DB.prepare("DELETE FROM sessions WHERE account=?").bind(parsed.data.id),
    ]);
    if (!result[0].meta.changes) throw new AppError("account_not_found", 404);
    await store.audit(
      parsed.data.disabled ? "account_disabled" : "account_enabled",
    );
    return json({ id: parsed.data.id, disabled: parsed.data.disabled });
  }
  if (p === "/admin/accounts/delete" && r.method === "POST") {
    const parsed = accountSchema.safeParse(await readJson(r));
    if (!parsed.success) throw new AppError("invalid_account");
    await deleteAccount(e, parsed.data.id, ctx);
    return json({ deleted: true });
  }
  if (p === "/account/delete" && r.method === "POST") {
    if (principal.role !== "user")
      throw new AppError("owner_account_protected", 403);
    await deleteAccount(e, principal.account, ctx);
    const response = json({ deleted: true });
    response.headers.append(
      "Set-Cookie",
      "__Host-ev_session=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
    );
    return response;
  }
  if (p === "/account/mcp-tokens" && r.method === "GET") {
    const { results } = await e.DB.prepare(
      "SELECT hash AS id,label,created FROM mcp_tokens WHERE account=? ORDER BY created",
    )
      .bind(principal.account)
      .all();
    return json({
      tokens: results,
      endpoint: e.APP_ORIGIN + "/mcp",
      installation_token: principal.account === "" && !!e.MCP_TOKEN,
    });
  }
  if (p === "/account/mcp-tokens" && r.method === "POST") {
    const parsed = z
      .object({ label })
      .strict()
      .safeParse(await readJson(r));
    if (!parsed.success) throw new AppError("invalid_label");
    const token = MCP_TOKEN_PREFIX + random().replace(/-/g, "");
    const result = await e.DB.prepare(
      "INSERT INTO mcp_tokens(hash,account,label,created) SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM mcp_tokens WHERE account=?) < ?",
    )
      .bind(
        await hash(token),
        principal.account,
        parsed.data.label,
        Date.now(),
        principal.account,
        MCP_TOKEN_LIMIT,
      )
      .run();
    if (!result.meta.changes) throw new AppError("mcp_token_limit", 409);
    await store.audit("mcp_token_created");
    // Shown once; only its hash is stored.
    return json({ token, endpoint: e.APP_ORIGIN + "/mcp" });
  }
  if (p === "/account/mcp-tokens/revoke" && r.method === "POST") {
    const parsed = idSchema.safeParse(await readJson(r));
    if (!parsed.success) throw new AppError("invalid_token_id");
    await e.DB.prepare("DELETE FROM mcp_tokens WHERE hash=? AND account=?")
      .bind(parsed.data.id, principal.account)
      .run();
    await store.audit("mcp_token_revoked");
    return json({ revoked: true });
  }
  return null;
}
