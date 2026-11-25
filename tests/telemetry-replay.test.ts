import { describe, it, expect } from "vitest";
import { replay } from "../scripts/lib/telemetry-replay";

describe("telemetry replay (npm run telemetry:replay)", () => {
  it("keeps the newest reading through late, repeated and lost records", async () => {
    const result = await replay();
    expect(result.failures).toEqual([]);
  });
});
