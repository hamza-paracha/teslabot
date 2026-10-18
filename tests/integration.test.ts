import {
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";

const testPublicKey = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).publicKey;
import app from "../src/index";
import { Store } from "../src/storage/database";
import { type Env } from "../src/types";
import { hash, seal, unseal } from "../src/security/crypto";
import {
  authorizationUrl,
  ownerToken,
  regions,
  tokenRequest,
} from "../src/tesla/auth";
import { TeslaClient } from "../src/tesla/client";
import { normalize } from "../src/tesla/normalization";
import { registerPartner, KEY_PATH } from "../src/tesla/partner";
let mf: Miniflare, e: Env, store: Store;
const origin = "https://tesla.example.com",
  vin = "5YJ3E1EA7KF000001";
const fixture = {
  charge_state: {
    battery_level: 71,
    battery_range: 200,
    charging_state: "Disconnected",
    timestamp: Date.now(),
  },
  climate_state: { inside_temp: 21, outside_temp: 4, timestamp: Date.now() },
  vehicle_state: { locked: true, odometer: 1000, timestamp: Date.now() },
};
const tokens = () => ({
  access_token: "tesla-access-secret",
  refresh_token: "tesla-refresh-secret",
  expires_in: 3600,
  expires_at: Date.now() + 3600000,
});
function req(path: string, init: RequestInit = {}, auth = true) {
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
  await DB.exec(
    readFileSync("migrations/0001_initial.sql", "utf8").replace(/\n/g, " "),
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
describe("security", () => {
  it.each([
    "/api/vehicle",
    "/api/vehicle/battery",
    "/api/vehicle/location",
    "/auth/status",
    "/auth/login",
  ])("blocks unauthenticated %s", async (p) =>
    expect((await req(p, {}, false)).status).toBe(401),
  );
  it("serves health and public key without authorization", async () => {
    expect((await req("/health", {}, false)).status).toBe(200);
    expect(await (await req(KEY_PATH, {}, false)).text()).toContain(
      "BEGIN PUBLIC KEY",
    );
  });
  it("never exposes private key or disabled commands", async () => {
    expect((await req("/private-key.pem")).status).toBe(404);
    expect(
      (await req("/api/vehicle/command/unlock", { method: "POST" })).status,
    ).toBe(403);
  });
  it("limits MCP credential to read endpoints", async () => {
    for (const p of ["/auth/status", "/auth/login", "/admin/partner/register"])
      expect(
        (await req(p, { headers: { Authorization: "Bearer " + e.MCP_TOKEN } }))
          .status,
      ).toBe(403);
  });
  it("encrypts records with context binding and detects tampering", async () => {
    const sealed = await seal(
      tokens(),
      e.TOKEN_ENCRYPTION_KEY!,
      "owner_tokens",
    );
    expect(sealed).not.toContain("tesla-access-secret");
    expect(
      (await unseal<any>(sealed, e.TOKEN_ENCRYPTION_KEY!, "owner_tokens"))
        .access_token,
    ).toBe("tesla-access-secret");
    await expect(
      unseal(sealed, e.TOKEN_ENCRYPTION_KEY!, "summary"),
    ).rejects.toThrow();
  });
  it("status never exposes tokens or VIN", async () => {
    await store.put("owner_tokens", tokens());
    await store.put("selected", { id: "opaque", vin });
    const text = await (await req("/auth/status")).text();
    expect(text).not.toContain("tesla-access-secret");
    expect(text).not.toContain("tesla-refresh-secret");
    expect(text).not.toContain(vin);
  });
  it("rejects cross-origin session creation", async () =>
    expect(
      (
        await req("/admin/session", {
          method: "POST",
          headers: { Origin: "https://evil.invalid" },
        })
      ).status,
    ).toBe(403));
});
describe("OAuth", () => {
  it("constructs exact least-privilege authorization URL", () => {
    const u = new URL(authorizationUrl(e, "state"));
    expect(u.origin).toBe("https://auth.tesla.com");
    expect(u.searchParams.get("scope")).toBe(
      "openid offline_access vehicle_device_data",
    );
    expect(u.searchParams.get("redirect_uri")).toBe(origin + "/auth/callback");
    expect(u.searchParams.get("state")).toBe("state");
  });
  async function transaction(expiry = Date.now() + 600000) {
    await e.DB.prepare(
      "INSERT INTO oauth_states(hash,browser_hash,expires) VALUES(?,?,?)",
    )
      .bind(await hash("state"), await hash("browser"), expiry)
      .run();
  }
  const callback = (query: string, browser = "browser") =>
    req(
      "/auth/callback?state=state&" + query,
      { headers: { Cookie: "__Host-ev_oauth=" + browser } },
      false,
    );
  it("generates unpredictable browser-bound state", async () => {
    const a = await req("/auth/login"),
      b = await req("/auth/login");
    expect(a.status).toBe(303);
    expect(a.headers.get("Location")).not.toBe(b.headers.get("Location"));
    expect(a.headers.get("Set-Cookie")).toContain("HttpOnly");
  });
  it("rejects missing state and invalid callback", async () =>
    expect((await req("/auth/callback?code=x", {}, false)).status).toBe(400));
  it("rejects expired state", async () => {
    await transaction(Date.now() - 1);
    expect((await callback("code=x")).status).toBe(400);
  });
  it("rejects a different browser", async () => {
    await transaction();
    expect((await callback("code=x", "other")).status).toBe(400);
  });
  it.each(["", "error=access_denied"])(
    "handles missing code or denied consent (%s)",
    async (query) => {
      await transaction();
      expect((await callback(query)).status).toBe(400);
      expect((await callback("code=x")).status).toBe(400);
    },
  );
  it("exchanges code, stores encrypted tokens and rejects replay", async () => {
    await transaction();
    const fetcher = vi.fn(async () => Response.json(tokens()));
    vi.stubGlobal("fetch", fetcher);
    expect((await callback("code=authorization-code")).status).toBe(303);
    expect((await store.get<any>("owner_tokens"))?.access_token).toBe(
      "tesla-access-secret",
    );
    expect((await callback("code=x")).status).toBe(400);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const params = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(params[1].body)).toContain("grant_type=authorization_code");
  });
  it("refreshes expired token and persists rotated refresh token", async () => {
    await store.put("owner_tokens", { ...tokens(), expires_at: 0 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ ...tokens(), refresh_token: "new-refresh" }),
      ),
    );
    await ownerToken(store);
    expect((await store.get<any>("owner_tokens")).refresh_token).toBe(
      "new-refresh",
    );
  });
  it("does not refresh a valid access token", async () => {
    await store.put("owner_tokens", tokens());
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    await ownerToken(store);
    expect(f).not.toHaveBeenCalled();
  });
  it("handles refresh failure without exposing upstream text", async () => {
    await store.put("owner_tokens", { ...tokens(), expires_at: 0 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("secret-details", { status: 401 })),
    );
    await expect(ownerToken(store)).rejects.toMatchObject({
      code: "reauthorization_required",
    });
  });
  it("rejects malformed token response", async () => {
    await expect(
      tokenRequest({}, async () => Response.json({ token: "oops" })),
    ).rejects.toMatchObject({ code: "invalid_token_response" });
  });
  it("disconnect deletes credentials, caches and sessions", async () => {
    await store.put("owner_tokens", tokens());
    await store.put("summary", { private: "data" });
    expect((await req("/auth/disconnect", { method: "POST" })).status).toBe(
      200,
    );
    expect(await store.get("owner_tokens")).toBeNull();
    expect(await store.get("summary")).toBeNull();
  });
});
describe("vehicle client and caching", () => {
  beforeEach(async () => {
    await store.put("owner_tokens", tokens());
  });
  it.each([
    [403, "permission_denied"],
    [408, "vehicle_unavailable"],
    [429, "tesla_rate_limited"],
    [401, "reauthorization_required"],
    [500, "tesla_server_error"],
    [422, "unsupported"],
  ])("normalizes status %s", async (status, code) => {
    const client = new TeslaClient(
      store,
      async () => new Response("upstream secrets", { status: Number(status) }),
    );
    await expect(client.vehicles()).rejects.toMatchObject({ code });
  });
  it("handles timeout", async () => {
    await expect(
      new TeslaClient(store, async () => {
        throw Error("abort");
      }).vehicles(),
    ).rejects.toMatchObject({ code: "tesla_timeout" });
  });
  it("rejects unexpected response and invalid identifiers", async () => {
    await expect(
      new TeslaClient(store, async () =>
        Response.json({ response: [{ vin: "bad" }] }),
      ).vehicles(),
    ).rejects.toMatchObject({ code: "unexpected_tesla_response" });
    await expect(
      new TeslaClient(store).vehicle("../evil"),
    ).rejects.toMatchObject({ code: "invalid_vehicle_identifier" });
  });
  it("normalizes SI units and missing fields without fabricated values", () => {
    const d = normalize(fixture, "opaque", "Tesla", false);
    expect(d.battery.range_km).toBeCloseTo(321.8688);
    expect(d.vehicle.odometer_km).toBeCloseTo(1609.344);
    expect(d).not.toHaveProperty("location");
    expect(
      normalize({ charge_state: {} }, "opaque", null, false).battery.percentage,
    ).toBeNull();
  });
  it("flags unknown observation timestamps as stale", () =>
    expect(
      normalize({ charge_state: {} }, "opaque", null, false).data.is_stale,
    ).toBe(true));
  it("enforces daily budget before fetch", async () => {
    const limit = e.MAX_REQUESTS_PER_DAY;
    e.MAX_REQUESTS_PER_DAY = "0";
    const f = vi.fn();
    await expect(new TeslaClient(store, f).vehicles()).rejects.toMatchObject({
      code: "local_usage_limit",
    });
    expect(f).not.toHaveBeenCalled();
    e.MAX_REQUESTS_PER_DAY = limit;
  });
  it("does not silently select a sole vehicle or expose its VIN", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          response: [{ vin, state: "asleep", display_name: "Car" }],
        }),
      ),
    );
    const r = await req("/api/vehicles");
    expect(r.status).toBe(200);
    expect(await r.text()).not.toContain(vin);
    expect(await store.get("selected")).toBeNull();
  });
  it("returns no vehicles honestly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ response: [] })),
    );
    expect(
      ((await (await req("/api/vehicles")).json()) as any).vehicles,
    ).toEqual([]);
  });
  it("never wakes an asleep vehicle", async () => {
    await store.put("selected", { id: "opaque", vin });
    const f = vi.fn(async () =>
      Response.json({ response: { vin, state: "asleep" } }),
    );
    vi.stubGlobal("fetch", f);
    const r = await req("/api/vehicle/battery");
    expect(r.status).toBe(409);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("returns explicitly stale cached data when vehicle sleeps", async () => {
    await store.put("selected", { id: "opaque", vin });
    const summary = normalize(fixture, "opaque", "Car", false);
    summary.data.retrieved_at = new Date(0).toISOString();
    await store.put("summary", summary);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ response: { vin, state: "asleep" } })),
    );
    const result = (await (await req("/api/vehicle/summary")).json()) as any;
    expect(result.data.is_stale).toBe(true);
    expect(result.data.refresh_error).toBe("vehicle_asleep");
  });
  it("reuses fresh cache without calling Tesla", async () => {
    await store.put("selected", { id: "opaque", vin });
    await store.put("summary", normalize(fixture, "opaque", "Car", false));
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect((await req("/api/vehicle/battery")).status).toBe(200);
    expect(f).not.toHaveBeenCalled();
  });
});
describe("partner registration", () => {
  const publicPem = testPublicKey;
  function mock(status = 200, lookup = true) {
    return vi.fn(async (url: any, init?: RequestInit) => {
      const s = String(url);
      if (s === origin + KEY_PATH) return new Response(publicPem);
      if (s.includes("/oauth2/")) return Response.json(tokens());
      if (s.includes("/public_key?"))
        return lookup
          ? Response.json({ response: { public_key: publicPem } })
          : new Response("", { status: 403 });
      return new Response("{}", { status });
    });
  }
  it("registers correct domain and verifies key with a partner token", async () => {
    const f = mock();
    const r = await registerPartner(store, f);
    expect(r.verified).toBe(true);
    const call = f.mock.calls.find(
      (c) =>
        c[1]?.method === "POST" && String(c[0]).endsWith("/partner_accounts"),
    )!;
    expect(String(call[0])).toBe(regions.na + "/api/1/partner_accounts");
    expect(call[1]?.body).toBe(JSON.stringify({ domain: "tesla.example.com" }));
    expect((call[1]?.headers as any).Authorization).toBe(
      "Bearer tesla-access-secret",
    );
  });
  it("accepts already-registered only after successful key verification", async () =>
    expect((await registerPartner(store, mock(409))).already_registered).toBe(
      true,
    ));
  it("does not report registration success when lookup fails", async () => {
    await expect(
      registerPartner(store, mock(403, false)),
    ).rejects.toMatchObject({ code: "partner_registration_failed" });
    expect(await store.get("partner_status")).toBeNull();
  });
  it("rejects unavailable public key", async () => {
    const assets = e.ASSETS;
    e.ASSETS = {
      fetch: async () => new Response("", { status: 404 }),
    } as unknown as Fetcher;
    try {
      await expect(registerPartner(store, mock())).rejects.toMatchObject({
        code: "public_key_unreachable",
      });
    } finally {
      e.ASSETS = assets;
    }
  });
  it("uses the asset binding instead of fetching its own Worker hostname", async () => {
    const f = mock();
    await registerPartner(store, f);
    expect(
      f.mock.calls.some((call) => String(call[0]).startsWith(origin)),
    ).toBe(false);
  });
});

describe("additional integration boundaries", () => {
  it("returns a normalized live-read fixture without tokens or VIN", async () => {
    await store.put("owner_tokens", tokens());
    await store.put("selected", { id: "opaque", vin });
    const f = vi.fn(async (url: any) =>
      Response.json({
        response: String(url).includes("vehicle_data")
          ? fixture
          : { vin, state: "online", display_name: "Car" },
      }),
    );
    vi.stubGlobal("fetch", f);
    const r = await req("/api/vehicle/summary");
    expect(r.status).toBe(200);
    const result = (await r.json()) as any;
    expect(result.battery.percentage).toBe(71);
    expect(result.data.already_awake).toBe(true);
    expect(result.data.source).toBe("tesla_fleet_api");
    expect(JSON.stringify(result)).not.toContain(vin);
    expect(JSON.stringify(result)).not.toContain("tesla-access-secret");
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("requires two real stored observations for changes", async () =>
    expect((await req("/api/vehicle/changes")).status).toBe(409));
  it("prevents monthly budget overspend", async () => {
    await store.put("owner_tokens", tokens());
    const limit = e.MAX_ESTIMATED_MONTHLY_SPEND_USD;
    e.MAX_ESTIMATED_MONTHLY_SPEND_USD = "0.001";
    try {
      await expect(
        new TeslaClient(store, vi.fn()).get(
          "/api/1/vehicles/" + vin + "/vehicle_data",
          "data",
        ),
      ).rejects.toMatchObject({ code: "local_usage_limit" });
    } finally {
      e.MAX_ESTIMATED_MONTHLY_SPEND_USD = limit;
    }
  });
  it("rejects a malformed selection body", async () => {
    expect(
      (
        await req("/api/vehicle/select", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "null",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await req("/api/vehicle/select", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "invalid",
        })
      ).status,
    ).toBe(400);
  });
  it("rejects oversized selection requests", async () =>
    expect(
      (
        await req("/api/vehicle/select", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "x".repeat(3000),
        })
      ).status,
    ).toBe(413));
  it("requires browser-origin verification for session mutations", async () => {
    const res = await req("/admin/session", {
      method: "POST",
      headers: { Origin: origin },
    });
    const session = res.headers.get("Set-Cookie")!.split(";")[0];
    expect(
      (
        await req(
          "/auth/disconnect",
          {
            method: "POST",
            headers: { Cookie: session, Origin: "https://evil.invalid" },
          },
          false,
        )
      ).status,
    ).toBe(403);
  });
  it("blocks partner registration when credentials are missing", async () => {
    const id = e.TESLA_CLIENT_ID;
    delete e.TESLA_CLIENT_ID;
    const f = vi.fn();
    try {
      await expect(registerPartner(store, f)).rejects.toMatchObject({
        code: "tesla_credentials_missing",
      });
      expect(f).not.toHaveBeenCalled();
    } finally {
      e.TESLA_CLIENT_ID = id;
    }
  });
  it("rejects unsupported malformed vehicle data", () =>
    expect(() =>
      normalize(
        { charge_state: { battery_level: "wrong" } },
        "opaque",
        null,
        false,
      ),
    ).toThrow("unexpected_tesla_response"));
});

it("preserves the native fetch receiver during OAuth token exchange", async () => {
  vi.stubGlobal("fetch", function (this: unknown) {
    expect(this).toBe(globalThis);
    return Promise.resolve(Response.json(tokens()));
  });
  expect(
    (await tokenRequest({ grant_type: "client_credentials" })).access_token,
  ).toBe("tesla-access-secret");
});

it("uses Workers-compatible manual mode for requests that forbid redirects", async () => {
  const { platformFetch } = await import("../src/tesla/fetch");
  const f = vi.fn(async (_input: unknown, init?: RequestInit) => {
    expect(init?.redirect).toBe("manual");
    return new Response("ok");
  });
  vi.stubGlobal("fetch", f);
  expect(
    (await platformFetch("https://example.com", { redirect: "error" })).status,
  ).toBe(200);
  expect(f).toHaveBeenCalledTimes(1);
});
it("refuses redirect responses without following the credential-bearing request", async () => {
  const { platformFetch } = await import("../src/tesla/fetch");
  const f = vi.fn(
    async () =>
      new Response(null, {
        status: 302,
        headers: { Location: "https://untrusted.invalid" },
      }),
  );
  vi.stubGlobal("fetch", f);
  await expect(
    platformFetch("https://example.com", {
      redirect: "error",
      headers: { Authorization: "Bearer test-secret" },
    }),
  ).rejects.toThrow("upstream_redirect_refused");
  expect(f).toHaveBeenCalledTimes(1);
});

it("verifies the live Tesla hex EC-point key representation against the hosted PEM", async () => {
  const { validPublicKey } = await import("../src/tesla/partner");
  const pem = testPublicKey;
  const key = await validPublicKey(pem);
  const hex = Buffer.from(await crypto.subtle.exportKey("raw", key)).toString(
    "hex",
  );
  const f = vi.fn(async (url: any, init?: RequestInit) => {
    if (String(url).includes("/oauth2/")) return Response.json(tokens());
    if (String(url).includes("/public_key?"))
      return Response.json({ response: { public_key: hex } });
    return Response.json({ response: { result: true } });
  });
  expect((await registerPartner(store, f)).verified).toBe(true);
});
it("rejects malformed registered EC-point encodings", async () => {
  const { registeredKeyBytes } = await import("../src/tesla/partner");
  await expect(
    registeredKeyBytes("04" + "00".repeat(64)),
  ).rejects.toMatchObject({ code: "invalid_public_key" });
});

describe("personal context and history routes", () => {
  const preferenceBody = {
    history_enabled: true,
    battery_change_percentage: 5,
    temperature_change_c: 3,
  };
  const savePreferences = (body = preferenceBody, headers = {}) =>
    req("/admin/preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  async function selected() {
    await store.put("owner_tokens", tokens());
    await store.put("selected", { id: "opaque", vin });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) =>
        Response.json({
          response: String(url).includes("vehicle_data")
            ? fixture
            : { vin, state: "online" },
        }),
      ),
    );
  }
  it("protects preferences and prevents MCP clients enabling history", async () => {
    expect((await req("/admin/preferences", {}, false)).status).toBe(401);
    expect(
      (
        await savePreferences(preferenceBody, {
          Authorization: "Bearer " + e.MCP_TOKEN,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await savePreferences({
          ...preferenceBody,
          battery_change_percentage: 0,
        })
      ).status,
    ).toBe(400);
  });
  it("keeps history off by default and makes no Tesla calls for stored history", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const result = (await (await req("/api/vehicle/history")).json()) as any;
    expect(result.enabled).toBe(false);
    expect(result.observations).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });
  it("returns grounded context and records encrypted opt-in observations only on live retrieval", async () => {
    await selected();
    await savePreferences();
    const response = await req("/api/vehicle/context");
    expect(response.status).toBe(200);
    const context = (await response.json()) as any;
    expect(context.narrative).toContain("71%");
    expect(context.changes).toEqual([]);
    expect(JSON.stringify(context)).not.toContain(vin);
    await req("/api/vehicle/context"); // Cache hit must not append a sample.
    const history = (await (await req("/api/vehicle/history")).json()) as any;
    expect(history.observations).toHaveLength(1);
    expect(history.observations[0].data.may_incur_api_charges).toBe(false);
    const ciphertext = await e.DB.prepare(
      "SELECT value FROM records WHERE key='observation_history'",
    ).first<{ value: string }>();
    expect(ciphertext?.value).not.toContain("battery");
    expect(ciphertext?.value).not.toContain("opaque");
  });
  it("removes opt-in history on disable and clears history/preferences on disconnect", async () => {
    await selected();
    await savePreferences();
    await req("/api/vehicle/context");
    await savePreferences({ ...preferenceBody, history_enabled: false });
    expect(await store.get("observation_history")).toBeNull();
    await store.put("observation_history", [
      normalize(fixture, "opaque", null, false),
    ]);
    await req("/auth/disconnect", { method: "POST" });
    expect(await store.get("observation_history")).toBeNull();
    expect(await store.get("preferences")).toBeNull();
  });
  it("rejects invalid trip inputs before contacting Tesla", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect((await req("/api/vehicle/trip?distance_km=-1")).status).toBe(400);
    expect(f).not.toHaveBeenCalled();
  });
  it("recalculates freshness for stored changes without contacting Tesla", async () => {
    const current = normalize(fixture, "opaque", null, false);
    current.data.observed_at = new Date(Date.now() - 600000).toISOString();
    current.data.is_stale = false;
    await store.put("summary", current);
    await store.put("previous_summary", current);
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const result = (await (await req("/api/vehicle/changes")).json()) as any;
    expect(result.data.is_stale).toBe(true);
    expect(result.data.may_incur_api_charges).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
});
