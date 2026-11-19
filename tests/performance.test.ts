import { describe, it, expect, vi } from "vitest";
import { TeslaClient } from "../src/tesla/client";
import { normalize } from "../src/tesla/normalization";
import { e, store, vin, fixture, tokens, req } from "./helpers/app";

const id = "a".repeat(24);
const sections = ["battery", "climate", "charging", "tires", "closures"];

describe("concurrent reads", () => {
  it("serves parallel cache hits without lock contention", async () => {
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
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const responses = await Promise.all(
      sections.map((section) => req("/api/vehicle/" + section)),
    );
    expect(responses.map((r) => r.status)).toEqual(sections.map(() => 200));
    expect(upstream).not.toHaveBeenCalled();
  });
  it("shares one Tesla refresh between parallel cold reads", async () => {
    await store.putMany({ selected: { id, vin }, owner_tokens: tokens() });
    const upstream = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/vehicle_data"))
        return Response.json({
          response: {
            ...fixture,
            charge_state: { ...fixture.charge_state, timestamp: Date.now() },
          },
        });
      return Response.json({
        response: { vin, state: "online", display_name: "Car" },
      });
    });
    vi.stubGlobal("fetch", upstream);
    const responses = await Promise.all(
      sections.map((section) => req("/api/vehicle/" + section)),
    );
    expect(responses.map((r) => r.status)).toEqual(sections.map(() => 200));
    const bodies = (await Promise.all(responses.map((r) => r.json()))) as any[];
    expect(bodies.filter((b) => b.data.cache_hit === false)).toHaveLength(1);
    expect(
      upstream.mock.calls.filter(([input]) =>
        String(input).includes("/vehicle_data"),
      ),
    ).toHaveLength(1);
  });
  it("reserves usage atomically so parallel requests cannot exceed the daily limit", async () => {
    await store.put("owner_tokens", tokens());
    const limit = e.MAX_REQUESTS_PER_DAY;
    e.MAX_REQUESTS_PER_DAY = "2";
    try {
      const client = new TeslaClient(
        store,
        vi.fn(async () => Response.json({ response: [] })),
      );
      const results = await Promise.allSettled(
        [1, 2, 3, 4].map(() => client.vehicles()),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
      expect(
        results
          .filter((r) => r.status === "rejected")
          .map((r) => (r as PromiseRejectedResult).reason.code),
      ).toEqual(["local_usage_limit", "local_usage_limit"]);
    } finally {
      e.MAX_REQUESTS_PER_DAY = limit;
    }
  });
});
