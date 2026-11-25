import { describe, it, expect } from "vitest";
import { runScenario } from "../scripts/lib/demo";

describe("round-trip demo (npm run demo)", () => {
  it("answers from one fresh read, then from the cache", async () => {
    const [first, followUp] = await runScenario("fresh");
    expect(first.upstream).toMatchObject({
      vehicle_data: 1,
      wake_or_command: 0,
    });
    expect(first.plan).toMatchObject({
      assessment: "within_reserve",
      start_percentage: 71,
      estimated_final_percentage: 31.4,
      data: { cache_hit: false, is_stale: false },
    });
    expect(followUp.upstream.total).toBe(0);
    expect(followUp.plan).toMatchObject({
      trip_id: first.plan.trip_id,
      minimum_departure_percentage: 69.6,
      data: { cache_hit: true, is_stale: false },
    });
  });
  it("withholds the estimate for a sleeping car without waking it", async () => {
    const steps = await runScenario("asleep");
    for (const { upstream, plan } of steps) {
      expect(upstream).toEqual({
        total: 1,
        vehicle_data: 0,
        wake_or_command: 0,
        calls: [
          expect.stringMatching(/^GET \/api\/1\/vehicles\/[A-Z0-9]{17}$/),
        ],
      });
      expect(plan).toMatchObject({
        assessment: "insufficient_fresh_data",
        start_percentage: null,
        estimated_final_percentage: null,
        minimum_departure_percentage: null,
        data: {
          is_stale: true,
          cache_hit: true,
          refresh_error: "vehicle_asleep",
        },
      });
      expect(plan.data.age_seconds).toBeGreaterThanOrEqual(3 * 3600);
    }
  });
});
