import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFileSync, readdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import app, { route } from "../../src/index";
import { Store } from "../../src/storage/database";
import { regions } from "../../src/tesla/auth";
import { AppError, type Env } from "../../src/types";

// A local, credential-free stand-in for a deployment: the real Worker routes,
// a Miniflare D1 database with every migration applied, application
// encryption, and a synthetic Tesla upstream that counts every request.
// Nothing here reaches the network.

const migrations = new URL("../../migrations/", import.meta.url);

export async function openDatabase() {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      name: "harness",
      modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      compatibilityDate: "2026-10-18",
      d1Databases: ["DB"],
    }),
  );
  const DB = await mf.getD1Database("DB");
  for (const file of readdirSync(migrations)
    .filter((name) => name.endsWith(".sql"))
    .sort())
    await DB.exec(
      readFileSync(new URL(file, migrations), "utf8").replace(/\n/g, " "),
    );
  return { mf, DB: DB as unknown as D1Database };
}

// Fixture identifiers in the same shape as real ones; no real car has them.
export const SYNTHETIC_VIN = "5YJ3E1EA7KF000001";
export const SYNTHETIC_VEHICLE_ID = "5f0c1a2b3c4d5e6f708192a3";

export type CarState = "online" | "asleep" | "offline";

export function syntheticTesla() {
  const car = {
    state: "online" as CarState,
    battery_level: 71,
    battery_range_miles: 205,
    charging_state: "Disconnected",
    charge_limit_soc: 80,
    // Added to every upstream response, to model Tesla's network latency.
    latency_ms: 0,
    // Source timestamp the car reports for each section.
    observed_at: () => Date.now(),
  };
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    if (url.origin !== regions.na)
      throw new TypeError(
        `Synthetic harness: no network access (${url.origin})`,
      );
    calls.push(`${method} ${url.pathname}`);
    if (method !== "GET" || /wake_up|command/.test(url.pathname))
      return Response.json({ error: "not_supported" }, { status: 403 });
    if (car.latency_ms)
      await new Promise((resolve) => setTimeout(resolve, car.latency_ms));
    const vehicle = {
      vin: SYNTHETIC_VIN,
      state: car.state,
      display_name: "Synthetic Model 3",
    };
    if (url.pathname === "/api/1/vehicles")
      return Response.json({ response: [vehicle] });
    if (url.pathname === `/api/1/vehicles/${SYNTHETIC_VIN}`)
      return Response.json({ response: vehicle });
    if (url.pathname === `/api/1/vehicles/${SYNTHETIC_VIN}/vehicle_data`) {
      if (car.state !== "online") return new Response(null, { status: 408 });
      const timestamp = car.observed_at();
      return Response.json({
        response: {
          charge_state: {
            battery_level: car.battery_level,
            battery_range: car.battery_range_miles,
            charging_state: car.charging_state,
            charge_limit_soc: car.charge_limit_soc,
            timestamp,
          },
          climate_state: { inside_temp: 19, outside_temp: 3, timestamp },
          vehicle_state: { locked: true, odometer: 18000, timestamp },
        },
      });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };
  const count = (kind?: "vehicle_data" | "wake") =>
    calls.filter((call) =>
      kind === "vehicle_data"
        ? call.endsWith("/vehicle_data")
        : kind === "wake"
          ? /wake_up|command/.test(call)
          : true,
    ).length;
  return { car, calls, fetch, count, reset: () => (calls.length = 0) };
}
export type SyntheticTesla = ReturnType<typeof syntheticTesla>;

const secret = (bytes = 32) => randomBytes(bytes).toString("hex");

export async function createHarness(overrides: Partial<Env> = {}) {
  const { mf, DB } = await openDatabase();
  const e: Env = {
    DB,
    ASSETS: {
      fetch: async () => new Response(null, { status: 404 }),
    } as unknown as Fetcher,
    APP_ORIGIN: "https://teslabot.localhost",
    TESLA_CLIENT_ID: "synthetic-client",
    TESLA_CLIENT_SECRET: secret(),
    // Fresh random credentials on every run; nothing is read from the environment.
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    ADMIN_TOKEN: secret(),
    MCP_TOKEN: secret(),
    TESLA_REGION: "na",
    ENABLE_LOCATION: "false",
    ENABLE_VEHICLE_COMMANDS: "false",
    ALLOW_VEHICLE_WAKE: "false",
    MAX_REQUESTS_PER_DAY: "1000000",
    MAX_ESTIMATED_MONTHLY_SPEND_USD: "1000000",
    CACHE_TTL_SECONDS: "300",
    ...overrides,
  };
  const store = new Store(e);
  const tesla = syntheticTesla();
  const original = globalThis.fetch;
  globalThis.fetch = tesla.fetch;
  // A connected account with the synthetic car selected.
  await store.putMany({
    selected: { id: SYNTHETIC_VEHICLE_ID, vin: SYNTHETIC_VIN },
    owner_tokens: {
      access_token: "synthetic-" + secret(16),
      refresh_token: "synthetic-" + secret(16),
      expires_in: 28800,
      expires_at: Date.now() + 28800000,
    },
  });
  const request = (
    path: string,
    init: RequestInit = {},
    token = e.MCP_TOKEN!,
  ) =>
    app.fetch(
      new Request(e.APP_ORIGIN + path, {
        ...init,
        headers: { Authorization: "Bearer " + token, ...init.headers },
      }),
      e,
    );
  // The path hosted /mcp tool calls take: in-process, as the account's
  // read-only principal, skipping bearer checks and the per-minute HTTP limit.
  const call = async (path: string, init: RequestInit = {}) => {
    try {
      return await route(new Request(e.APP_ORIGIN + path, init), e, undefined, {
        role: "reader",
        account: "",
      });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      return Response.json(
        { error: { code: error.code } },
        { status: error.status },
      );
    }
  };
  return {
    e,
    store,
    tesla,
    request,
    call,
    async close() {
      globalThis.fetch = original;
      await mf.dispose();
    },
  };
}
export type Harness = Awaited<ReturnType<typeof createHarness>>;
