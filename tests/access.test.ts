import { describe, expect, it, vi } from "vitest";
import { makeSession } from "../src/security/authorization";
import { normalize } from "../src/tesla/normalization";
import { vehicleId } from "../src/tesla/vehicles";
import { e, store, origin, vin, fixture, tokens, req } from "./helpers/app";

const vehicle = { vin, state: "online", display_name: "Fixture car" };
const reader = { Authorization: "Bearer " + "m".repeat(64) };
async function beginReconnect() {
  const response = await req("/auth/reconnect", { method: "POST" });
  expect(response.status).toBe(200);
  const body = (await response.json()) as any;
  const url = new URL(body.authorization_url);
  expect(url.origin).toBe("https://auth.tesla.com");
  expect(url.searchParams.get("prompt")).toBe("login");
  expect(url.searchParams.get("scope")).not.toMatch(
    /cmd|charging_cmd|user_data/,
  );
  return {
    state: url.searchParams.get("state")!,
    cookie: response.headers.get("Set-Cookie")!.split(";")[0],
  };
}
const complete = (
  attempt: { state: string; cookie: string },
  query = "code=fixture-code",
  html = false,
) =>
  req(
    `/auth/callback?state=${encodeURIComponent(attempt.state)}&${query}`,
    {
      headers: {
        Cookie: attempt.cookie,
        ...(html ? { Accept: "text/html" } : {}),
      },
    },
    false,
  );

describe("owner reconnection", () => {
  it("invalidates pending reconnect transactions on disconnect", async () => {
    await store.put("owner_tokens", tokens());
    const attempt = await beginReconnect();
    await req("/auth/disconnect", { method: "POST" });
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    expect((await complete(attempt)).status).toBe(400);
    expect(await store.get("owner_tokens")).toBeNull();
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects a replacement token response without refresh access before clearing existing data", async () => {
    const previous = tokens();
    await store.put("owner_tokens", previous);
    const attempt = await beginReconnect();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ access_token: "new-fixture-access", expires_in: 3600 }),
      ),
    );
    const response = await complete(attempt);
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("missing_refresh_token");
    expect(await store.get("owner_tokens")).toEqual(previous);
  });

  it("requires admin access and same-origin browser mutations", async () => {
    expect(
      (await req("/auth/reconnect", { method: "POST" }, false)).status,
    ).toBe(401);
    expect(
      (await req("/auth/reconnect", { method: "POST", headers: reader }))
        .status,
    ).toBe(403);
    const cookie = "__Host-ev_session=" + (await makeSession(e));
    expect(
      (
        await req(
          "/auth/reconnect",
          {
            method: "POST",
            headers: { Cookie: cookie, Origin: "https://evil.invalid" },
          },
          false,
        )
      ).status,
    ).toBe(403);
    expect(
      (await e.DB.prepare("SELECT * FROM oauth_states").all()).results,
    ).toHaveLength(0);
  });

  it.each(["error=access_denied", "", "code=fixture-code"])(
    "preserves existing connection and data on a failed attempt (%s)",
    async (query) => {
      const previous = tokens();
      await store.putMany({
        owner_tokens: previous,
        summary: { fixture: true },
        selected: { id: "old", vin },
      });
      const oldSession = "__Host-ev_session=" + (await makeSession(e));
      const upstream = vi.fn(
        async () => new Response("secret-upstream-error", { status: 400 }),
      );
      vi.stubGlobal("fetch", upstream);
      const attempt = await beginReconnect();
      expect(await store.get("owner_tokens")).toEqual(previous);
      expect((await complete(attempt, query)).status).toBeGreaterThanOrEqual(
        400,
      );
      expect(await store.get("owner_tokens")).toEqual(previous);
      expect(await store.get("summary")).toEqual({ fixture: true });
      expect(
        (await req("/auth/status", { headers: { Cookie: oldSession } }, false))
          .status,
      ).toBe(200);
      expect(await (await complete(attempt)).text()).toContain(
        "expired_or_replayed_state",
      );
      expect(upstream).toHaveBeenCalledTimes(query.startsWith("code=") ? 1 : 0);
    },
  );

  it("replaces tokens only after success, clears old account data and renews the browser session", async () => {
    await store.putMany({
      owner_tokens: tokens(),
      selected: { id: "old", vin },
      vehicles: { vehicles: [vehicle], at: Date.now() },
      summary: { fixture: true },
      previous_summary: { fixture: true },
      observation_history: [{ fixture: true }],
      preferences: { history_enabled: true },
    });
    const oldSession = "__Host-ev_session=" + (await makeSession(e));
    const attempt = await beginReconnect();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ...tokens(),
          refresh_token: "replacement-refresh-fixture",
        }),
      ),
    );
    const callback = await complete(attempt);
    expect(callback.status).toBe(303);
    expect(callback.headers.get("Location")).toBe("/?oauth=connected");
    expect((await store.get<any>("owner_tokens")).refresh_token).toBe(
      "replacement-refresh-fixture",
    );
    for (const key of [
      "selected",
      "vehicles",
      "summary",
      "previous_summary",
      "observation_history",
      "preferences",
    ])
      expect(await store.get(key)).toBeNull();
    expect(
      (await req("/auth/status", { headers: { Cookie: oldSession } }, false))
        .status,
    ).toBe(401);
    const newSession = callback.headers
      .get("Set-Cookie")!
      .match(/__Host-ev_session=[^;, ]+/)![0];
    expect(
      (await req("/auth/status", { headers: { Cookie: newSession } }, false))
        .status,
    ).toBe(200);
    expect((await complete(attempt)).status).toBe(400);
    expect(
      JSON.stringify(
        (await e.DB.prepare("SELECT * FROM records").all()).results,
      ),
    ).not.toContain("replacement-refresh-fixture");
  });

  it("does not allow a regular connect transaction to replace an account", async () => {
    const login = await req("/auth/login");
    const state = new URL(login.headers.get("Location")!).searchParams.get(
      "state",
    )!;
    const attempt = {
      state,
      cookie: login.headers.get("Set-Cookie")!.split(";")[0],
    };
    await store.put("owner_tokens", tokens());
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    expect((await complete(attempt)).status).toBe(409);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("binds replacement sign-in to its browser without consuming another browser's transaction", async () => {
    await store.put("owner_tokens", tokens());
    const attempt = await beginReconnect();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(tokens())),
    );
    expect(
      (await complete({ ...attempt, cookie: "__Host-ev_oauth=other-browser" }))
        .status,
    ).toBe(400);
    expect((await complete(attempt)).status).toBe(303);
  });

  it("returns browser OAuth errors to a clean dashboard URL without upstream text, state or code", async () => {
    const attempt = await beginReconnect();
    const response = await complete(
      attempt,
      "error=access_denied&error_description=secret-upstream&code=secret-code",
      true,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(
      "/?oauth_error=oauth_consent_denied",
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe("");
    const missing = await req(
      "/auth/callback?code=secret",
      { headers: { Accept: "text/html" } },
      false,
    );
    expect(missing.headers.get("Location")).toBe(
      "/?oauth_error=invalid_oauth_state",
    );
  });

  it("redirects an expired admin login to the dashboard and clears cookies on disconnect", async () => {
    const response = await req(
      "/auth/login",
      { headers: { Accept: "text/html" } },
      false,
    );
    expect(response.headers.get("Location")).toBe("/?oauth_error=unauthorized");
    const disconnected = await req("/auth/disconnect", { method: "POST" });
    expect(disconnected.headers.get("Set-Cookie")).toContain(
      "__Host-ev_session=;",
    );
    expect(disconnected.headers.get("Set-Cookie")).toContain(
      "__Host-ev_oauth=;",
    );
  });
});

describe("vehicle discovery and selection recovery", () => {
  it("distinguishes missing account, unknown discovery and a successful empty discovery without Tesla battery calls", async () => {
    const upstream = vi.fn(async () => Response.json({ response: [] }));
    vi.stubGlobal("fetch", upstream);
    let battery = (await (
      await req("/api/vehicle/battery", { headers: reader })
    ).json()) as any;
    expect(battery.error).toMatchObject({
      code: "tesla_not_connected",
      dashboard_url: origin + "/",
    });
    await store.put("owner_tokens", tokens());
    battery = (await (
      await req("/api/vehicle/battery", { headers: reader })
    ).json()) as any;
    expect(battery.error).toMatchObject({
      code: "select_vehicle_first",
      next_steps: expect.any(Array),
    });
    expect(upstream).not.toHaveBeenCalled();
    const result = (await (
      await req("/api/vehicles", { headers: reader })
    ).json()) as any;
    expect(result).toMatchObject({
      status: "no_authorized_vehicles",
      vehicles: [],
      selected_id: null,
      guidance: { code: "no_authorized_vehicles", dashboard_url: origin + "/" },
      data: { cache_hit: false },
    });
    expect(result.guidance.message).toContain("does not establish");
    battery = (await (
      await req("/api/vehicle/battery", { headers: reader })
    ).json()) as any;
    expect(battery.error.code).toBe("no_authorized_vehicles");
    expect(battery).not.toHaveProperty("battery");
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("refreshes an empty cached list on explicit request, then still requires selection even for one vehicle", async () => {
    await store.put("owner_tokens", tokens());
    const upstream = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ response: [] }))
      .mockResolvedValue(Response.json({ response: [vehicle] }));
    vi.stubGlobal("fetch", upstream);
    await req("/api/vehicles");
    const cached = (await (await req("/api/vehicles")).json()) as any;
    expect(cached.data.cache_hit).toBe(true);
    expect(upstream).toHaveBeenCalledTimes(1);
    const refreshed = (await (
      await req("/api/vehicles?refresh=true", { headers: reader })
    ).json()) as any;
    expect(refreshed).toMatchObject({
      status: "selection_required",
      selected_id: null,
      data: { cache_hit: false },
    });
    expect(refreshed.vehicles).toHaveLength(1);
    expect(JSON.stringify(refreshed)).not.toContain(vin);
    expect(await store.get("selected")).toBeNull();
    expect(upstream).toHaveBeenCalledTimes(2);
    expect((await req("/api/vehicles?refresh=invalid")).status).toBe(400);
  });

  it("invalidates selection and observations when discovery no longer authorizes the chosen car", async () => {
    const id = await vehicleId(vehicle);
    await store.putMany({
      owner_tokens: tokens(),
      selected: { id, vin },
      vehicles: { vehicles: [vehicle], at: Date.now() },
      summary: normalize(fixture, id, null, false),
      previous_summary: { fixture: true },
      observation_history: [{ fixture: true }],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ response: [] })),
    );
    const result = (await (
      await req("/api/vehicles?refresh=true")
    ).json()) as any;
    expect(result).toMatchObject({
      status: "no_authorized_vehicles",
      selected_id: null,
    });
    for (const key of [
      "selected",
      "summary",
      "previous_summary",
      "observation_history",
    ])
      expect(await store.get(key)).toBeNull();
    expect((await req("/api/vehicle/cached")).status).toBe(409);
    expect(
      (
        await req("/api/vehicle/select", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        })
      ).status,
    ).toBe(403);
  });

  it("reports missing explicit scope but treats an omitted scope as unknown", async () => {
    const upstream = vi.fn(async () => Response.json({ response: [vehicle] }));
    vi.stubGlobal("fetch", upstream);
    await store.put("owner_tokens", {
      ...tokens(),
      scope: "openid offline_access",
    });
    let status = (await (await req("/auth/status")).json()) as any;
    expect(status.authorization.vehicle_information).toBe("missing");
    const denied = (await (await req("/api/vehicles")).json()) as any;
    expect(denied.error).toMatchObject({
      code: "missing_vehicle_data_scope",
      next_steps: expect.any(Array),
    });
    expect(upstream).not.toHaveBeenCalled();
    const battery = (await (await req("/api/vehicle/battery")).json()) as any;
    expect(battery.error.code).toBe("missing_vehicle_data_scope");
    await store.put("owner_tokens", tokens());
    status = (await (await req("/auth/status")).json()) as any;
    expect(status.authorization.vehicle_information).toBe("unknown");
    expect((await req("/api/vehicles")).status).toBe(200);
  });

  it("does not turn permission failures into successful empty discovery", async () => {
    await store.put("owner_tokens", tokens());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("secret-error-details", { status: 403 })),
    );
    const response = await req("/api/vehicles");
    expect(response.status).toBe(403);
    const result = (await response.json()) as any;
    expect(result.error).toMatchObject({
      code: "permission_denied",
      dashboard_url: origin + "/",
    });
    expect(result).not.toHaveProperty("vehicles");
    expect(JSON.stringify(result)).not.toContain("secret-error-details");
    expect(await store.get("vehicles")).toBeNull();
  });

  it.each([401, 403, 404])(
    "does not fall back to a stale reading when access is rejected (%s)",
    async (status) => {
      const id = await vehicleId(vehicle);
      const summary = normalize(fixture, id, null, false);
      summary.data.retrieved_at = new Date(0).toISOString();
      await store.putMany({
        owner_tokens: tokens(),
        selected: { id, vin },
        summary,
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("private-upstream-details", { status })),
      );
      const response = await req("/api/vehicle/battery");
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain('"percentage"');
    },
  );

  it("does not use a cached battery from a different selected vehicle", async () => {
    await store.putMany({
      owner_tokens: tokens(),
      selected: { id: "other", vin },
      summary: normalize(fixture, "old", null, false),
    });
    const upstream = vi.fn(async () =>
      Response.json({ response: { ...vehicle, state: "asleep" } }),
    );
    vi.stubGlobal("fetch", upstream);
    expect((await req("/api/vehicle/battery")).status).toBe(409);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
