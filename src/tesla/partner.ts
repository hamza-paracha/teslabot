import { platformFetch } from "./fetch";
import type { Env } from "../types";
import { AppError } from "../types";
import { Store } from "../storage/database";
import { regions, tokenRequest, type Tokens } from "./auth";
export const KEY_PATH = "/.well-known/appspecific/com.tesla.3p.public-key.pem";
export function pemBytes(pem: string) {
  return Uint8Array.from(
    atob(pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s/g, "")),
    (c) => c.charCodeAt(0),
  );
}
export async function validPublicKey(pem: string) {
  if (
    !pem.startsWith("-----BEGIN PUBLIC KEY-----") ||
    !pem.trim().endsWith("-----END PUBLIC KEY-----")
  )
    throw new AppError("invalid_public_key", 502);
  try {
    return await crypto.subtle.importKey(
      "spki",
      pemBytes(pem),
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );
  } catch {
    throw new AppError("invalid_public_key", 502);
  }
}
export async function registeredKeyBytes(value: string): Promise<Uint8Array> {
  if (value.startsWith("-----BEGIN PUBLIC KEY-----")) {
    return new Uint8Array(
      await crypto.subtle.exportKey("raw", await validPublicKey(value)),
    );
  }
  // Tesla's live partner lookup returns the SEC1 uncompressed P-256 point as hex.
  if (!/^04[0-9a-fA-F]{128}$/.test(value))
    throw new AppError("invalid_public_key", 502);
  const bytes = Uint8Array.from(value.match(/../g)!, (pair) =>
    parseInt(pair, 16),
  );
  try {
    await crypto.subtle.importKey(
      "raw",
      bytes,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return bytes;
  } catch {
    throw new AppError("invalid_public_key", 502);
  }
}
export async function registerPartner(
  store: Store,
  fetcher: typeof fetch = platformFetch,
) {
  const e = store.env,
    domain = new URL(e.APP_ORIGIN).hostname;
  if (!e.TESLA_CLIENT_ID || !e.TESLA_CLIENT_SECRET)
    throw new AppError("tesla_credentials_missing", 503);
  // Read our own asset through its binding, avoiding a network request back into this Worker.
  // External HTTPS reachability is checked by the administrative CLI and deployment smoke checks.
  const pub = await e.ASSETS.fetch(new Request(e.APP_ORIGIN + KEY_PATH));
  if (!pub.ok) throw new AppError("public_key_unreachable", 502);
  const expected = await pub.text();
  const expectedKey = await validPublicKey(expected);
  return store.locked("partner", async () => {
    let token = await store.get<Tokens>("partner_tokens");
    if (!token || token.expires_at < Date.now() + 60000) {
      for (let attempt = 0; ; attempt++) {
        try {
          token = await tokenRequest(
            {
              grant_type: "client_credentials",
              client_id: e.TESLA_CLIENT_ID!,
              client_secret: e.TESLA_CLIENT_SECRET!,
              audience: regions[e.TESLA_REGION],
              scope: "vehicle_device_data",
            },
            fetcher,
          );
          break;
        } catch (error) {
          if (attempt >= 2) throw error;
          await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
        }
      }
      await store.put("partner_tokens", token);
    }
    const headers = {
      Authorization: "Bearer " + token.access_token,
      "Content-Type": "application/json",
    };
    const reg = await fetcher(
      regions[e.TESLA_REGION] + "/api/1/partner_accounts",
      {
        method: "POST",
        headers,
        body: JSON.stringify({ domain }),
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      },
    );
    // A failed POST is never treated as success unless the key lookup verifies the existing registration.
    const lookup = await fetcher(
      regions[e.TESLA_REGION] +
        "/api/1/partner_accounts/public_key?domain=" +
        encodeURIComponent(domain),
      { headers, redirect: "error", signal: AbortSignal.timeout(15000) },
    );
    if (!lookup.ok)
      throw new AppError(
        reg.ok ? "partner_key_lookup_failed" : "partner_registration_failed",
        502,
      );
    const body = (await lookup.json()) as {
      response?: { public_key?: string } | string;
    };
    const actual =
      typeof body.response === "string"
        ? body.response
        : body.response?.public_key;
    if (typeof actual !== "string")
      throw new AppError("unexpected_partner_key_response", 502);
    const actualRaw = await registeredKeyBytes(actual);
    const expectedRaw = new Uint8Array(
      await crypto.subtle.exportKey("raw", expectedKey),
    );
    if (Array.from(actualRaw).join(",") !== Array.from(expectedRaw).join(","))
      throw new AppError("registered_key_mismatch", 502);
    const result = {
      verified: true,
      region: e.TESLA_REGION,
      domain,
      verified_at: new Date().toISOString(),
      already_registered: !reg.ok,
    };
    await store.put("partner_status", result);
    await store.audit("partner_registered");
    return result;
  });
}
