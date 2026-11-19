import { describe, it, expect, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
const { default: worker } = await import("../telemetry/src/index");

const relayToken = "r".repeat(48);
function env() {
  const forwarded = vi.fn(async (request: Request) =>
    Response.json({ path: new URL(request.url).pathname }),
  );
  return {
    forwarded,
    env: {
      RELAY_TOKEN: relayToken,
      TELEMETRY_SERVER: { getByName: () => ({ fetch: forwarded }) },
    } as any,
  };
}
const call = (e: any, path: string, token?: string, method = "POST") =>
  worker.fetch(
    new Request("https://telemetry.internal" + path, {
      method,
      headers: token ? { Authorization: "Bearer " + token } : {},
      ...(method === "POST" ? { body: "{}" } : {}),
    }),
    e,
  );

describe("telemetry Worker", () => {
  it("passes only authenticated /configure calls to the container", async () => {
    const { env: e, forwarded } = env();
    expect((await call(e, "/configure")).status).toBe(401);
    expect((await call(e, "/configure", "x".repeat(48))).status).toBe(401);
    expect((await call(e, "/command/unlock", relayToken)).status).toBe(404);
    expect((await call(e, "/configure", relayToken, "GET")).status).toBe(404);
    expect(forwarded).not.toHaveBeenCalled();
    const ok = await call(e, "/configure", relayToken);
    expect(ok.status).toBe(200);
    expect(forwarded).toHaveBeenCalledTimes(1);
    expect(
      (await call({ ...e, RELAY_TOKEN: "short" }, "/configure", "short"))
        .status,
    ).toBe(401);
  });
});
