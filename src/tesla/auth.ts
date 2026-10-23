import { platformFetch } from "./fetch";
import { z } from "zod";
import { AppError, type Env } from "../types";
import { Store } from "../storage/database";
export const TOKEN_URL =
  "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token";
export const regions = {
  na: "https://fleet-api.prd.na.vn.cloud.tesla.com",
  eu: "https://fleet-api.prd.eu.vn.cloud.tesla.com",
} as const;
export const scopes = (e: Env) => [
  "openid",
  "offline_access",
  "vehicle_device_data",
  ...(e.ENABLE_LOCATION === "true" ? ["vehicle_location"] : []),
];
const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  expires_in: z.number().positive(),
  scope: z.string().optional(),
});
export type Tokens = z.infer<typeof tokenSchema> & { expires_at: number };
export function authorizationUrl(e: Env, state: string) {
  const u = new URL("https://auth.tesla.com/oauth2/v3/authorize");
  u.search = new URLSearchParams({
    client_id: e.TESLA_CLIENT_ID!,
    redirect_uri: e.APP_ORIGIN + "/auth/callback",
    response_type: "code",
    // Tesla's documented example requests a fresh login instead of silently
    // reusing the developer account's existing browser session.
    prompt: "login",
    scope: scopes(e).join(" "),
    state,
    prompt_missing_scopes: "true",
    require_requested_scopes: "true",
  }).toString();
  return u.toString();
}
export async function tokenRequest(
  params: Record<string, string>,
  fetcher: typeof fetch = platformFetch,
): Promise<Tokens> {
  let r: Response;
  try {
    r = await fetcher(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
  } catch {
    throw new AppError("tesla_auth_unavailable", 502);
  }
  if (!r.ok)
    throw new AppError(
      r.status === 401
        ? "reauthorization_required"
        : "tesla_token_exchange_failed",
      r.status === 401 ? 401 : 502,
    );
  let body: unknown;
  try {
    body = await r.json();
  } catch {
    throw new AppError("invalid_token_response", 502);
  }
  const parsed = tokenSchema.safeParse(body);
  if (!parsed.success) throw new AppError("invalid_token_response", 502);
  return {
    ...parsed.data,
    expires_at: Date.now() + parsed.data.expires_in * 1000,
  };
}
export async function ownerToken(store: Store): Promise<Tokens> {
  let t = await store.get<Tokens>("owner_tokens");
  if (!t) throw new AppError("tesla_not_connected", 409);
  if (t.expires_at > Date.now() + 60000) return t;
  return store.locked("account", async () => {
    t = await store.get<Tokens>("owner_tokens");
    if (!t) throw new AppError("tesla_not_connected", 409);
    if (t.expires_at > Date.now() + 60000) return t;
    if (!t.refresh_token) throw new AppError("reauthorization_required", 401);
    const updated = await tokenRequest({
      grant_type: "refresh_token",
      client_id: store.env.TESLA_CLIENT_ID!,
      refresh_token: t.refresh_token,
    });
    if (!updated.refresh_token)
      throw new AppError("missing_rotated_refresh_token", 502);
    updated.scope ??= t.scope;
    await store.put("owner_tokens", updated);
    await store.audit("token_refreshed");
    return updated;
  });
}
