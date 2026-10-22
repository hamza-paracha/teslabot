import { describe, it, expect, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import app from "../src/index";
import { createServer } from "../mcp/src/server";
import { regions } from "../src/tesla/auth";
import { e, store, origin, vin, fixture, tokens, req } from "./helpers/app";

describe("account-to-agent workflow with mocked Tesla and real D1 storage", () => {
  it("connects, selects, reads battery over MCP, plans, rotates tokens and disconnects", async () => {
    const vehicle = { vin, state: "online", display_name: "Test fixture car" };
    const upstream = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.hostname === "fleet-auth.prd.vn.cloud.tesla.com") {
          const body = new URLSearchParams(String(init?.body));
          expect(body.get("client_id")).toBe(e.TESLA_CLIENT_ID);
          if (body.get("grant_type") === "authorization_code") {
            expect(body.get("code")).toBe("fixture-code");
            expect(body.get("redirect_uri")).toBe(origin + "/auth/callback");
            return Response.json(tokens());
          }
          expect(body.get("grant_type")).toBe("refresh_token");
          expect(body.get("refresh_token")).toBe(tokens().refresh_token);
          return Response.json({
            ...tokens(),
            access_token: "rotated-access-fixture",
            refresh_token: "rotated-refresh-fixture",
          });
        }
        expect(url.origin).toBe(regions.na);
        expect(init?.method ?? "GET").toBe("GET");
        expect(url.pathname).not.toMatch(/wake|command/);
        if (url.pathname === "/api/1/vehicles")
          return Response.json({ response: [vehicle] });
        if (url.pathname === `/api/1/vehicles/${vin}`)
          return Response.json({ response: vehicle });
        if (url.pathname === `/api/1/vehicles/${vin}/vehicle_data`) {
          expect(url.searchParams.get("endpoints")).not.toContain("location");
          const at = Date.now();
          return Response.json({
            response: {
              charge_state: { ...fixture.charge_state, timestamp: at },
              climate_state: { ...fixture.climate_state, timestamp: at },
              vehicle_state: { ...fixture.vehicle_state, timestamp: at },
            },
          });
        }
        throw Error("Unexpected mock upstream path");
      },
    );
    vi.stubGlobal("fetch", upstream);
    const login = await req("/auth/login");
    const authorization = new URL(login.headers.get("Location")!);
    expect(authorization.searchParams.get("prompt")).toBe("login");
    const state = authorization.searchParams.get("state")!;
    const browserCookie = login.headers.get("Set-Cookie")!.split(";")[0];
    const callback = await req(
      `/auth/callback?state=${encodeURIComponent(state)}&code=fixture-code`,
      { headers: { Cookie: browserCookie } },
      false,
    );
    expect(callback.status).toBe(303);
    const session = callback.headers
      .get("Set-Cookie")!
      .match(/__Host-ev_session=[^;, ]+/)![0];
    const browserReq = (path: string, init: RequestInit = {}) =>
      req(
        path,
        {
          ...init,
          headers: { Cookie: session, Origin: origin, ...init.headers },
        },
        false,
      );
    expect((await browserReq("/auth/status")).status).toBe(200);
    const list = (await (await browserReq("/api/vehicles")).json()) as any;
    expect(list.vehicles).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(vin);
    expect(
      ((await (await browserReq("/auth/status")).json()) as any)
        .vehicle_selected,
    ).toBe(false);
    expect(
      (
        await browserReq("/api/vehicle/select", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: list.vehicles[0].id }),
        })
      ).status,
    ).toBe(200);

    // A real MCP client invokes the actual Worker handlers. Only Tesla is mocked.
    const bridge: typeof fetch = async (input, init) =>
      app.fetch(new Request(String(input), init), e);
    const server = createServer(origin, e.MCP_TOKEN!, bridge);
    const client = new Client({ name: "workflow-test", version: "1.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      const battery = await client.callTool({
        name: "tesla_get_battery",
        arguments: {},
      });
      expect(battery.isError).not.toBe(true);
      expect((battery.structuredContent as any).battery.percentage).toBe(71);
      const requests = upstream.mock.calls.length;
      await client.callTool({ name: "tesla_get_battery", arguments: {} });
      const trip = await client.callTool({
        name: "tesla_estimate_trip",
        arguments: { distance_km: 100 },
      });
      expect((trip.structuredContent as any).assessment).toBe(
        "within_reported_range_estimate",
      );
      const now = Date.now();
      const departure = await client.callTool({
        name: "tesla_plan_departures",
        arguments: {
          events: [
            {
              id: "test-event",
              title: "Fixture meeting",
              starts_at: new Date(now + 35 * 60000).toISOString(),
              location: "Fixture destination",
              travel_mode: "driving",
              travel_minutes: 30,
              total_distance_km: 300,
            },
          ],
          departure_forecast: {
            source: "test-fixture",
            location_label: "Fixture origin",
            issued_at: new Date(now).toISOString(),
            hours: [
              {
                at: new Date(now + 5 * 60000).toISOString(),
                temperature_c: -5,
              },
            ],
          },
          delivery: {
            enabled: true,
            time_zone: "UTC",
            quiet_start_hour: 0,
            quiet_end_hour: 0,
          },
        },
      });
      const planned = departure.structuredContent as any;
      expect(planned.briefing.should_notify).toBe(true);
      expect(
        planned.briefing.suggestions.map((item: any) => item.kind),
      ).toEqual(["offer_cabin_preconditioning", "review_trip_charge"]);
      expect(planned.actions_executed).toBe(false);
      expect(upstream).toHaveBeenCalledTimes(requests); // Cache + planner never polls Tesla.
      for (const output of [battery, trip, departure]) {
        const text = JSON.stringify(output);
        for (const secret of [
          vin,
          tokens().access_token,
          tokens().refresh_token,
          e.ADMIN_TOKEN!,
          e.MCP_TOKEN!,
        ])
          expect(text).not.toContain(secret);
      }
      const encrypted = await e.DB.prepare("SELECT * FROM records").all();
      expect(JSON.stringify(encrypted)).not.toContain(tokens().refresh_token);
      await store.put("owner_tokens", { ...tokens(), expires_at: 0 });
      await e.DB.prepare("DELETE FROM records WHERE key='summary'").run();
      const refreshed = await client.callTool({
        name: "tesla_get_battery",
        arguments: {},
      });
      expect(refreshed.isError).not.toBe(true);
      expect((await store.get<any>("owner_tokens")).refresh_token).toBe(
        "rotated-refresh-fixture",
      );
      expect(
        (await browserReq("/auth/disconnect", { method: "POST" })).status,
      ).toBe(200);
      expect((await browserReq("/auth/status")).status).toBe(401);
      expect(await store.get("owner_tokens")).toBeNull();
      expect(
        (await client.callTool({ name: "tesla_get_battery", arguments: {} }))
          .isError,
      ).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
