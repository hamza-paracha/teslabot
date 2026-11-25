import { describe, it, expect } from "vitest";
import {
  loadFixture,
  replay,
  type Fixture,
} from "../scripts/lib/telemetry-replay";

type Batch = NonNullable<Fixture["steps"][number]["batch"]>;

describe("telemetry replay (npm run telemetry:replay)", () => {
  it("keeps the newest reading through late, repeated and lost records", async () => {
    const result = await replay();
    expect(result.failures).toEqual([]);
    const lostResponse = result.steps.find(
      (step) => step.kind === "lost response",
    );
    expect(lostResponse).toMatchObject({ records: 1, ingest: undefined });
  });

  it.each(["forward", "reverse", "interleaved"])(
    "reaches the same per-account result with %s delivery and duplicates",
    async (order) => {
      const fixture = loadFixture();
      // Only delivered records participate. The lost queue and cron are not
      // stream events; alerts read the converged state after delivery.
      const records = fixture.steps.flatMap((step) => step.batch ?? []);
      const ordered =
        order === "reverse"
          ? records.reverse()
          : order === "interleaved"
            ? records
                .filter((_, i) => i % 2)
                .concat(records.filter((_, i) => i % 2 === 0))
            : records;
      const size =
        order === "forward" ? ordered.length : order === "reverse" ? 1 : 3;
      const steps: Fixture["steps"] = [];
      for (let i = 0; i < ordered.length; i += size) {
        const batch = ordered.slice(i, i + size);
        steps.push({
          name: `batch ${i}`,
          batch: [...batch, ...batch],
          expect: { failed_accounts: 0 },
        });
      }
      steps.push(
        { name: "Run alerts", cron: true },
        { name: "Run alerts again", cron: true },
      );
      const result = await replay({ ...fixture, steps });
      expect(result.failures).toEqual([]);
    },
  );

  it("keeps the first conflicting value at a tie but accepts new fields", async () => {
    const fixture = loadFixture();
    const first: Batch[number] = {
      car: "owner",
      topic: "V",
      at: -60,
      data: { BatteryLevel: 44 },
    };
    const second: Batch[number] = {
      ...first,
      data: { BatteryLevel: 49, ChargeLimitSoc: 85 },
    };
    const result = await replay({
      ...fixture,
      steps: [
        {
          name: "Deliver tied records in opposite orders for two accounts",
          batch: [
            first,
            second,
            { ...second, car: "driver" },
            { ...first, car: "driver" },
          ],
          expect: { applied: 3, ignored: 1 },
        },
        {
          name: "Redeliver both records",
          batch: [second, first],
          expect: { applied: 0, ignored: 2 },
        },
      ],
      expect: {
        "owner.battery.percentage": 44,
        "driver.battery.percentage": 49,
        "owner.charging.limit_percentage": 85,
        "driver.charging.limit_percentage": 85,
        "owner.data.sections.battery.observed_at": { at: -60 },
        "driver.data.sections.battery.observed_at": { at: -60 },
      },
    });
    expect(result.failures).toEqual([]);
  });

  it("derives online status from source time even when connectivity and readings cross", async () => {
    const fixture = loadFixture();
    const reading: Batch[number] = {
      car: "owner",
      topic: "V",
      at: -40,
      data: { BatteryLevel: 42 },
    };
    const disconnect: Batch[number] = {
      car: "owner",
      topic: "connectivity",
      at: -50,
      status: "DISCONNECTED",
    };
    const forDriver = (record: Batch[number]): Batch[number] => ({
      ...record,
      car: "driver",
    });
    const result = await replay({
      ...fixture,
      steps: [
        {
          name: "An undated disconnect sets an initial state only",
          batch: [{ ...disconnect, at: null }],
          expect: {
            "telemetry.owner.connected": false,
            "telemetry.owner.clock.connectivity.at": null,
          },
        },
        {
          name: "An older disconnect arrives before and after a reading",
          batch: [reading, disconnect, forDriver(disconnect)],
          expect: {
            "owner.vehicle.online": true,
            "telemetry.owner.connected": false,
            "telemetry.owner.clock.connectivity.at": { at: -50 },
          },
        },
        {
          name: "The second account receives its reading in another batch",
          batch: [forDriver(reading)],
          expect: {
            "driver.vehicle.online": true,
            "telemetry.driver.connected": false,
          },
        },
        {
          name: "Disconnect and vehicle data at the same instant",
          batch: [
            { ...disconnect, at: -20 },
            { ...reading, at: -20 },
            forDriver({ ...reading, at: -20 }),
            forDriver({ ...disconnect, at: -20 }),
          ],
          expect: {
            "owner.vehicle.online": false,
            "driver.vehicle.online": false,
          },
        },
        {
          name: "A subsequent CONNECTED updates the stored summary without a new reading",
          batch: [
            { ...disconnect, at: -10, status: "CONNECTED" },
            forDriver({ ...disconnect, at: -10, status: "CONNECTED" }),
          ],
        },
        {
          name: "An undated retry and conflicting connectivity tie cannot undo the connection",
          batch: [
            { ...disconnect, at: null },
            { ...disconnect, at: -10 },
          ],
        },
      ],
      expect: {
        "owner.vehicle.online": true,
        "driver.vehicle.online": true,
        "telemetry.owner.connected": true,
        "telemetry.driver.connected": true,
        "owner.data.sections.battery.observed_at": { at: -20 },
        "driver.data.sections.battery.observed_at": { at: -20 },
      },
    });
    expect(result.failures).toEqual([]);
  });
});
