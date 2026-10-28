import { expect, it, vi } from "vitest";
import { e, req, store } from "./helpers/app";
import { normalize } from "../src/tesla/normalization";

it("protects routines and reads only selected, opt-in encrypted history with no Tesla calls", async () => {
  const network = vi.fn();
  vi.stubGlobal("fetch", network);
  expect((await req("/api/vehicle/routines", {}, false)).status).toBe(401);
  const read = async () => {
    const response = await req("/api/vehicle/routines", {
      headers: { Authorization: "Bearer " + e.MCP_TOKEN },
    });
    expect(response.status).toBe(200);
    return (await response.json()) as any;
  };
  expect(await read()).toMatchObject({
    enabled: false,
    assessment: "insufficient_data",
    sample_size: 0,
    time_zone_source: "utc_fallback",
  });
  const history = [3, 2, 1].flatMap((days) => {
    const date = new Date(Date.now() - days * 86400000)
      .toISOString()
      .slice(0, 10);
    return [22, 23].map((hour) => {
      const time = `${date}T${hour}:00:00Z`;
      const o = normalize(
        {
          charge_state: {
            charging_state: hour === 22 ? "Stopped" : "Charging",
            timestamp: Date.parse(time),
          },
        },
        "opaque",
        null,
        false,
      );
      o.data.retrieved_at = time;
      return o;
    });
  });
  await store.put("selected", { id: "opaque", vin: "server-only" });
  await store.put("observation_history", history);
  // Leftover history and the two latest observations must not bypass opt-in.
  await store.put("summary", history[0]);
  await store.put("previous_summary", history[1]);
  expect((await read()).sample_size).toBe(0);
  const preferences = {
    history_enabled: true,
    battery_change_percentage: 5,
    temperature_change_c: 3,
    time_zone: "UTC",
  };
  expect(
    (
      await req("/admin/preferences", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(preferences),
      })
    ).status,
  ).toBe(200);
  expect(await read()).toMatchObject({
    enabled: true,
    assessment: "routine_observed",
    sample_size: 6,
    time_zone_source: "configured",
    data: { may_incur_api_charges: false, already_awake: null },
  });
  await store.put("selected", { id: "different" });
  expect((await read()).assessment).toBe("insufficient_data");
  expect(await store.get("observation_history")).toEqual([]);
  expect(network).not.toHaveBeenCalled();
});
