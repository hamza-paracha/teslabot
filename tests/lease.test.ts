import { describe, it, expect, vi } from "vitest";
import { Store } from "../src/storage/database";
import { ownerToken } from "../src/tesla/auth";
import { e } from "./helpers/app";

// Each request builds its own Store, so two holders are two Store instances.
// Expiring a lease is simulated by moving its expiry into the past, which is
// what 120 s of wall-clock time does to a slow holder.
const expire = (name: string) =>
  e.DB.prepare("UPDATE locks SET expires=0 WHERE name=?").bind(name).run();
const lockOwner = async (name: string) =>
  (
    await e.DB.prepare("SELECT owner FROM locks WHERE name=?")
      .bind(name)
      .first<{ owner: string }>()
  )?.owner ?? null;

describe("lock leases", () => {
  it("rejects writes from a holder whose lease expired and was taken over", async () => {
    const first = new Store(e),
      next = new Store(e);
    let releaseNext!: () => void;
    const nextMayFinish = new Promise<void>((done) => (releaseNext = done));
    let nextHolder!: Promise<void>;
    let nextOwner: string | null = null;

    const firstHolder = first.locked("vehicle", async () => {
      await expire("vehicle");
      let acquired!: () => void;
      const nextAcquired = new Promise<void>((done) => (acquired = done));
      nextHolder = next.locked("vehicle", async () => {
        await next.put("summary", "written by the next holder");
        acquired();
        await nextMayFinish;
      });
      await nextAcquired;
      nextOwner = await lockOwner("vehicle");
      await first.put("summary", "stale write from the expired holder");
    });

    await expect(firstHolder).rejects.toMatchObject({ code: "lease_lost" });
    // The expired holder's release leaves the next holder's lock in place.
    expect(await lockOwner("vehicle")).toBe(nextOwner);
    releaseNext();
    await nextHolder;
    expect(await first.get("summary")).toBe("written by the next holder");
    expect(await lockOwner("vehicle")).toBeNull();
  });

  it("rejects writes after the next holder has already finished", async () => {
    const first = new Store(e),
      next = new Store(e);
    const firstHolder = first.locked("vehicle", async () => {
      await expire("vehicle");
      await next.locked("vehicle", () =>
        next.put("summary", "written by the next holder"),
      );
      await first.put("summary", "stale write from the expired holder");
    });
    await expect(firstHolder).rejects.toMatchObject({ code: "lease_lost" });
    expect(await first.get("summary")).toBe("written by the next holder");
  });

  it("rejects writes inside a nested lock once the outer lease is lost", async () => {
    // Reconnecting writes under "vehicle" and "account" together and clears
    // vehicle data, so losing either lease must stop it.
    const first = new Store(e),
      next = new Store(e);
    await next.put("preferences", "saved before the takeover");
    await first.locked("vehicle", async () => {
      await expire("vehicle");
      await next.locked("vehicle", () =>
        next.put("preferences", "saved by the next holder"),
      );
      await expect(
        first.locked("account", () =>
          first.putMany({}, [first.deleteKeys(["preferences"])]),
        ),
      ).rejects.toMatchObject({ code: "lease_lost" });
    });
    expect(await first.get("preferences")).toBe("saved by the next holder");
  });

  it("saves a rotated Tesla token even after the caller's vehicle lease is lost", async () => {
    const first = new Store(e),
      next = new Store(e);
    await first.put("owner_tokens", {
      access_token: "old",
      refresh_token: "spent-by-tesla",
      expires_at: 0,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          access_token: "new",
          refresh_token: "rotated",
          expires_in: 3600,
        }),
      ),
    );
    await first.locked("vehicle", async () => {
      await expire("vehicle");
      await next.locked("vehicle", async () => {});
      expect((await ownerToken(first)).refresh_token).toBe("rotated");
    });
    expect(
      (await first.get<{ refresh_token: string }>("owner_tokens"))
        ?.refresh_token,
    ).toBe("rotated");
  });

  it("still writes when the lease expired but nobody took it over", async () => {
    const first = new Store(e);
    await first.locked("vehicle", async () => {
      await expire("vehicle");
      await first.put("summary", "late but uncontested");
    });
    expect(await first.get("summary")).toBe("late but uncontested");
  });
});
