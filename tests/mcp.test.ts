import { it, expect, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../mcp/src/server";
it("lists seven read-only tools and invokes battery over MCP with a mocked backend", async () => {
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
    expect(tools.tools).toHaveLength(7);
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
