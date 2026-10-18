import { validPublicKey, KEY_PATH } from "../src/tesla/partner";
const origin = process.env.TESLABOT_URL,
  token = process.env.TESLABOT_ADMIN_TOKEN;
if (!origin || !token)
  throw Error(
    "Set TESLABOT_URL and TESLABOT_ADMIN_TOKEN in your local shell; do not paste credentials into chat.",
  );
const u = new URL(origin);
if (u.protocol !== "https:" || u.pathname !== "/" || u.username || u.password)
  throw Error("Use your exact HTTPS origin");
const publicResponse = await fetch(u.origin + KEY_PATH, {
  redirect: "error",
  signal: AbortSignal.timeout(15000),
});
if (!publicResponse.ok)
  throw Error(
    "Public key HTTPS check failed; check domain/DNS propagation before registering.",
  );
await validPublicKey(await publicResponse.text());
const r = await fetch(u.origin + "/admin/partner/register", {
  method: "POST",
  headers: { Authorization: "Bearer " + token },
  redirect: "error",
  signal: AbortSignal.timeout(60000),
});
if (!r.headers.get("Content-Type")?.includes("application/json"))
  throw Error(
    "Backend returned a non-JSON response (HTTP " +
      r.status +
      "); check DNS routing.",
  );
const result = await r.json();
if (!r.ok)
  throw Error("Partner registration failed: " + JSON.stringify(result));
console.log(JSON.stringify(result, null, 2));
export {};
