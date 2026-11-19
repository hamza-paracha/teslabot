import { it, expect, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../mcp/src/server";
import { buildContext, defaultPreferences } from "../src/context/observations";
import { normalize } from "../src/tesla/normalization";
const observation = () =>
  normalize(
    {
      charge_state: {
        battery_level: 62,
        battery_range: 200,
        charging_state: "Disconnected",
        timestamp: Date.now(),
      },
      climate_state: { inside_temp: 18, timestamp: Date.now() },
      vehicle_state: { locked: false, df: 0, rt: 1, timestamp: Date.now() },
    },
    "opaque",
    "Car",
    false,
  );
async function connect(backend: typeof fetch) {
  const server = createServer(
    "https://tesla.example.com",
    "m".repeat(64),
    backend,
  );
  const client = new Client({ name: "test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
it("lists eight tools and answers status questions with one snapshot call", async () => {
  const backend = vi.fn(async (_url: any, _options?: RequestInit) =>
    Response.json(buildContext(observation(), null, defaultPreferences)),
  );
  const { client, close } = await connect(backend);
  try {
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "tesla_get_history",
      "tesla_get_snapshot",
      "tesla_get_vehicles",
      "tesla_plan_charging",
      "tesla_plan_departures",
      "tesla_plan_trip",
      "tesla_record_trip_outcome",
      "tesla_schedule_briefings",
    ]);
    // Only planner tools that save trip/briefing state are not read-only.
    expect(
      tools.tools
        .filter((t) => !t.annotations?.readOnlyHint)
        .map((t) => t.name)
        .sort(),
    ).toEqual([
      "tesla_plan_trip",
      "tesla_record_trip_outcome",
      "tesla_schedule_briefings",
    ]);
    expect(tools.tools.every((t) => !t.annotations?.destructiveHint)).toBe(
      true,
    );
    const result = await client.callTool({
      name: "tesla_get_snapshot",
      arguments: {},
    });
    const full = result.structuredContent as any;
    expect(full.battery.percentage).toBe(62);
    expect(full.narrative).toContain("62%");
    expect(full.readiness.assessment).toBe("attention_needed");
    expect(full.readiness.attention.map((item: any) => item.code)).toEqual([
      "vehicle_unlocked",
      "rear_trunk_open",
    ]);
    expect(full.changes).toEqual([]);
    expect(full).not.toHaveProperty("location");
    expect(full).not.toHaveProperty("observation");
    expect(full.data.source).toBe("tesla_fleet_api");
    expect(backend).toHaveBeenCalledTimes(1);
    expect(backend.mock.calls[0][0]).toBe(
      "https://tesla.example.com/api/vehicle/context",
    );
    const narrow = (
      await client.callTool({
        name: "tesla_get_snapshot",
        arguments: { sections: ["battery", "location"] },
      })
    ).structuredContent as any;
    expect(Object.keys(narrow).sort()).toEqual([
      "battery",
      "data",
      "limitations",
      "location",
      "narrative",
      "unavailable_sections",
      "vehicle",
    ]);
    expect(narrow.location).toBeNull();
    expect(narrow.unavailable_sections).toEqual(["location"]);
  } finally {
    await close();
  }
});
it("passes backend errors through the snapshot without vehicle data", async () => {
  const { client, close } = await connect(
    vi.fn(async () =>
      Response.json({ error: { code: "vehicle_asleep" } }, { status: 409 }),
    ),
  );
  try {
    const result = await client.callTool({
      name: "tesla_get_snapshot",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: { code: "vehicle_asleep" },
    });
  } finally {
    await close();
  }
});
it("rejects insecure or arbitrary backend URLs", () => {
  expect(() => createServer("http://evil.invalid", "m".repeat(64))).toThrow();
  expect(() =>
    createServer("https://example.com/arbitrary", "m".repeat(64)),
  ).toThrow();
});

it("posts validated trip plans and follow-ups to the backend", async () => {
  const backend = vi.fn(async () =>
    Response.json({ trip_id: "b".repeat(24), assessment: "within_reserve" }),
  );
  const { client, close } = await connect(backend);
  try {
    const result = await client.callTool({
      name: "tesla_plan_trip",
      arguments: {
        destination: "Cottage",
        legs: [{ to: "Cottage", distance_km: 80 }],
        return_distance_km: 82,
        reserve_percentage: 25,
      },
    });
    expect(result.structuredContent).toMatchObject({
      assessment: "within_reserve",
    });
    const [url, init] = backend.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://tesla.example.com/api/trips");
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(JSON.parse(init.body as string)).toEqual({
      destination: "Cottage",
      legs: [{ to: "Cottage", distance_km: 80 }],
      return_distance_km: 82,
      reserve_percentage: 25,
    });
    const invalid = await client.callTool({
      name: "tesla_plan_trip",
      arguments: { legs: [{ to: "Nowhere", distance_km: -20 }] },
    });
    expect(invalid.isError).toBe(true);
    const listed = await client.callTool({
      name: "tesla_schedule_briefings",
      arguments: {},
    });
    expect(listed.isError).toBe(false);
    expect((backend.mock.calls.at(-1) as unknown as [string])[0]).toBe(
      "https://tesla.example.com/api/briefings",
    );
    expect(backend).toHaveBeenCalledTimes(2);
  } finally {
    await close();
  }
});

it("plans cold-weather offers through MCP even when cached vehicle data is unavailable", async () => {
  const backend = vi.fn(async () =>
    Response.json(
      { error: { code: "no_cached_observation" } },
      { status: 409 },
    ),
  );
  const server = createServer(
    "https://tesla.example.com",
    "m".repeat(64),
    backend,
  );
  const client = new Client({ name: "test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const result = await client.callTool({
      name: "tesla_plan_departures",
      arguments: { events: [] },
    });
    expect(result.structuredContent).toMatchObject({
      plans: [],
      vehicle_data_error: "no_cached_observation",
      actions_executed: false,
    });
    expect(backend).toHaveBeenCalledWith(
      "https://tesla.example.com/api/vehicle/cached",
      expect.anything(),
    );
  } finally {
    await client.close();
    await server.close();
  }
});
