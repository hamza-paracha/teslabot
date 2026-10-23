import { beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFileSync, readdirSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import app from "../../src/index";
import { Store } from "../../src/storage/database";
import type { Env } from "../../src/types";
import { KEY_PATH } from "../../src/tesla/partner";

export const testPublicKey = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).publicKey;

let mf: Miniflare;
export let e: Env, store: Store;
export const origin = "https://tesla.example.com",
  vin = "5YJ3E1EA7KF000001";
export const fixture = {
  charge_state: {
    battery_level: 71,
    battery_range: 200,
    charging_state: "Disconnected",
    timestamp: Date.now(),
  },
  climate_state: { inside_temp: 21, outside_temp: 4, timestamp: Date.now() },
  vehicle_state: { locked: true, odometer: 1000, timestamp: Date.now() },
};
export const tokens = () => ({
  access_token: "tesla-access-secret",
  refresh_token: "tesla-refresh-secret",
  expires_in: 3600,
  expires_at: Date.now() + 3600000,
});
export function req(path: string, init: RequestInit = {}, auth = true) {
  return app.fetch(
    new Request(origin + path, {
      ...init,
      headers: {
        ...(auth ? { Authorization: "Bearer " + e.ADMIN_TOKEN } : {}),
        ...init.headers,
      },
    }),
    e,
  );
}
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      name: "test",
      modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      compatibilityDate: "2026-10-18",
      d1Databases: ["DB"],
    }),
  );
  const DB = await mf.getD1Database("DB");
  for (const migration of readdirSync("migrations")
    .filter((file) => file.endsWith(".sql"))
    .sort())
    await DB.exec(
      readFileSync("migrations/" + migration, "utf8").replace(/\n/g, " "),
    );
  e = {
    DB: DB as unknown as D1Database,
    ASSETS: {
      fetch: async (r: Request) => {
        const p = new URL(r.url).pathname;
        if (p === KEY_PATH) return new Response(testPublicKey);
        return new Response("dashboard");
      },
    } as Fetcher,
    APP_ORIGIN: origin,
    TESLA_CLIENT_ID: "client-id",
    TESLA_CLIENT_SECRET: "client-secret",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    ADMIN_TOKEN: "a".repeat(64),
    MCP_TOKEN: "m".repeat(64),
    TESLA_REGION: "na",
    ENABLE_LOCATION: "false",
    ENABLE_VEHICLE_COMMANDS: "false",
    ALLOW_VEHICLE_WAKE: "false",
    MAX_REQUESTS_PER_DAY: "50",
    MAX_ESTIMATED_MONTHLY_SPEND_USD: "5",
    CACHE_TTL_SECONDS: "300",
  };
  store = new Store(e);
});
beforeEach(async () => {
  await e.DB.batch(
    ["records", "oauth_states", "sessions", "locks", "usage", "audit"].map(
      (t) => e.DB.prepare("DELETE FROM " + t),
    ),
  );
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => mf.dispose());
