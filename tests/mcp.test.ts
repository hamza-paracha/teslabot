import { it, expect, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../mcp/src/server";
it("lists thirteen read-only tools and invokes battery over MCP with a mocked backend", async () => {
  const backend = vi.fn(async (_url: any, _options?: RequestInit) =>
    Response.json({
      vehicle: { id: "opaque" },
      battery: { percentage: 62 },
      data: {
        source: "mock_test_fixture",
        is_stale: false,
        observed_at: new Date().toISOString(),
        already_awake: true,
        may_incur_api_charges: true,
      },
    }),
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
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(13);
    expect(tools.tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
    const result = await client.callTool({
      name: "tesla_get_battery",
      arguments: {},
    });
    expect((result.structuredContent as any).battery.percentage).toBe(62);
    expect(backend.mock.calls[0][0]).toBe(
      "https://tesla.example.com/api/vehicle/battery",
    );
  } finally {
    await client.close();
    await server.close();
  }
});
it("rejects insecure or arbitrary backend URLs", () => {
  expect(() => createServer("http://evil.invalid", "m".repeat(64))).toThrow();
  expect(() =>
    createServer("https://example.com/arbitrary", "m".repeat(64)),
  ).toThrow();
});

it("passes validated trip distance and reserve through the read-only backend", async () => {
  const backend = vi.fn(async () =>
    Response.json({ assessment: "insufficient_fresh_data" }),
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
      name: "tesla_estimate_trip",
      arguments: { distance_km: 80, reserve_percentage: 25 },
    });
    expect(result.structuredContent).toMatchObject({
      assessment: "insufficient_fresh_data",
    });
    expect(backend).toHaveBeenCalledWith(
      "https://tesla.example.com/api/vehicle/trip?distance_km=80&reserve_percentage=25",
      expect.objectContaining({ redirect: "error" }),
    );
    const invalid = await client.callTool({
      name: "tesla_estimate_trip",
      arguments: { distance_km: -20 },
    });
    expect(invalid.isError).toBe(true);
    expect(backend).toHaveBeenCalledTimes(1);
  } finally {
    await client.close();
    await server.close();
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

it("requests a host route for a place name without contacting Tesla", async () => {
  const backend = vi.fn();
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
      name: "tesla_assess_destination",
      arguments: { destination: "Airport" },
    });
    expect(result.structuredContent).toMatchObject({
      assessment: "route_required",
      destination: "Airport",
      one_way: null,
      round_trip: null,
    });
    expect(backend).not.toHaveBeenCalled();
  } finally {
    await client.close();
    await server.close();
  }
});
