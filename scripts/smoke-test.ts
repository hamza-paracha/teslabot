import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validPublicKey, KEY_PATH, pemBytes } from "../src/tesla/partner";
const origin = process.env.TESLABOT_URL;
if (!origin) throw Error("Set TESLABOT_URL");
const u = new URL(origin);
assert.equal(u.protocol, "https:");
for (const p of ["/health", KEY_PATH]) {
  const r = await fetch(u.origin + p, { redirect: "error" });
  assert.equal(r.status, 200);
  if (p === KEY_PATH) {
    const pem = await r.text();
    await validPublicKey(pem);
    assert.deepEqual(
      pemBytes(pem),
      pemBytes(readFileSync("public" + KEY_PATH, "utf8")),
    );
  } else assert.equal(((await r.json()) as any).mode, "read_only");
}
for (const p of [
  "/api/vehicle/battery",
  "/api/vehicle/location",
  "/auth/status",
]) {
  assert.equal((await fetch(u.origin + p, { redirect: "error" })).status, 401);
}
assert.notEqual((await fetch(u.origin + "/private-key.pem")).status, 200);
console.log(
  "Public health, public-key match and unauthenticated route protection verified. No Tesla requests made.",
);
