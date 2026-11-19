import { describe, it, expect, vi } from "vitest";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import app from "../src/index";
import { normalize } from "../src/tesla/normalization";
import { e, store, origin, vin, fixture, req } from "./helpers/app";

const id = "a".repeat(24);
const worker: typeof fetch = async (input, init) =>
  app.fetch(new Request(input, init), e);

async function connect(token: string) {
  const client = new Client({ name: "remote-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(origin + "/mcp"), {
      fetch: worker,
      requestInit: { headers: { Authorization: "Bearer " + token } },
    }),
  );
  return client;
}

describe("hosted MCP endpoint", () => {
  it("serves tools over Streamable HTTP with the read-only credential", async () => {
    await store.putMany({
      selected: { id, vin },
      summary: normalize(
        {
          ...fixture,
          charge_state: { ...fixture.charge_state, timestamp: Date.now() },
        },
        id,
        "Car",
        false,
      ),
    });
    const tesla = vi.fn();
    vi.stubGlobal("fetch", tesla);
    // Match workerd, which rejects redirect "error" when constructing a Request.
    const NativeRequest = Request;
    vi.stubGlobal(
      "Request",
      class extends NativeRequest {
        constructor(input: RequestInfo | URL, init?: RequestInit) {
          if (init?.redirect === "error")
            throw new TypeError("Invalid redirect value");
          super(input, init);
        }
      },
    );
    const client = await connect(e.MCP_TOKEN!);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain("tesla_get_snapshot");
      const snapshot = await client.callTool({
        name: "tesla_get_snapshot",
        arguments: { sections: ["battery"] },
      });
      expect(snapshot.isError).toBe(false);
      expect(snapshot.structuredContent).toMatchObject({
        battery: { percentage: 71 },
        data: { cache_hit: true },
      });
      const trip = await client.callTool({
        name: "tesla_plan_trip",
        arguments: { legs: [{ to: "Office", distance_km: 40 }] },
      });
      expect((trip.structuredContent as any).assessment).toBe("within_reserve");
      expect(JSON.stringify([snapshot, trip])).not.toContain(vin);
      expect(tesla).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });
  it("requires a bearer credential and rejects cookies or wrong tokens", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    expect(
      (await req("/mcp", { method: "POST", headers, body }, false)).status,
    ).toBe(401);
    expect(
      (
        await req(
          "/mcp",
          {
            method: "POST",
            headers: { ...headers, Cookie: "__Host-ev_session=forged" },
            body,
          },
          false,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await req(
          "/mcp",
          {
            method: "POST",
            headers: { ...headers, Authorization: "Bearer " + "x".repeat(64) },
            body,
          },
          false,
        )
      ).status,
    ).toBe(401);
  });
});
