import { createServer, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { AUTHORIZE_URL, type Car } from "./mock-tesla";
import { ORIGIN, startSandbox, type Sandbox } from "./sandbox";
import { addSandboxWorld, CARS } from "./sandbox-world";

// Interactive sandbox. The Worker still runs in workerd as https://localhost:8787;
// this server makes it usable from a browser at http://localhost:<port>:
//   /                the real dashboard (proxied to the Worker)
//   /__mock/         control panel: the simulated cars, cron, inbox, Tesla log
//   /__mock/authorize  stand-in for Tesla's sign-in and consent page
// Browsers accept Secure cookies on localhost over http, so the Worker's
// __Host- cookies work unchanged. Origin headers and absolute URLs are mapped
// between the two origins; nothing else is altered.

const escape = (value: unknown) =>
  String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (title: string, body: string) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>
<style>
body{font:15px/1.45 system-ui,sans-serif;max-width:980px;margin:24px auto;padding:0 16px;color:#1d1d1f;background:#f5f5f7}
h1{font-size:22px}h2{font-size:17px;margin-top:28px}.banner{background:#fff4cc;border:1px solid #e6c200;padding:8px 12px;border-radius:8px}
.card{background:#fff;border-radius:12px;padding:14px 16px;margin:12px 0;box-shadow:0 1px 3px #0002}
button{font:inherit;padding:6px 12px;margin:3px;border-radius:8px;border:1px solid #bbb;background:#fff;cursor:pointer}
button.primary{background:#171a20;color:#fff;border-color:#171a20}table{border-collapse:collapse;width:100%}
td,th{text-align:left;padding:4px 8px;border-bottom:1px solid #eee;font-size:13px;vertical-align:top}code{font-size:12px}
label{display:block;margin:6px 0}form.inline{display:inline}
</style><body><p class="banner">Sandbox: mock Tesla, synthetic cars, no network access.</p>${body}`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
const redirect = (location: string, cookies: string[] = []) => {
  const headers = new Headers({ Location: location });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
};

export async function serveSandbox(port: number, location: boolean) {
  const s = await startSandbox({ location });
  addSandboxWorld(s.mock);
  const local = `http://localhost:${port}`;
  const { mock } = s;
  const pending = new Map<string, string>();

  async function forward(req: IncomingMessage, body: Buffer | undefined) {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers))
      if (value !== undefined && name !== "host" && name !== "connection")
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    // Any local origin (a preview proxy may use its own port) maps to the Worker's.
    const origin = headers.get("origin");
    if (origin && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))
      headers.set("origin", ORIGIN);
    const host = req.headers["x-forwarded-host"] ?? req.headers.host;
    const visible = host ? `http://${host}` : local;
    const response = await s.dispatch(ORIGIN + req.url, {
      method: req.method,
      headers,
      body: body?.length ? new Uint8Array(body) : undefined,
    });
    const out = new Headers(response.headers);
    out.delete("Strict-Transport-Security");
    const target = out.get("Location");
    if (target?.startsWith(AUTHORIZE_URL))
      out.set("Location", "/__mock/authorize" + new URL(target).search);
    else if (target?.startsWith(ORIGIN))
      out.set("Location", target.slice(ORIGIN.length) || "/");
    if (!out.get("Content-Type")?.includes("application/json"))
      return new Response(response.body, {
        status: response.status,
        headers: out,
      });
    // Absolute URLs in API responses (invite links, guidance) point here.
    const text = (await response.text())
      .replaceAll(AUTHORIZE_URL, visible + "/__mock/authorize")
      .replaceAll(ORIGIN, visible);
    out.delete("Content-Length");
    return new Response(text, { status: response.status, headers: out });
  }

  const carRow = (car: Car, index: number) => `
<div class="card"><b>${escape(car.display_name)}</b> · ${escape(car.model)} · owner: ${escape(mock.identities.get(car.owner)?.name)}
<table><tr><th>state</th><th>battery</th><th>charging</th><th>locked</th><th>rear passenger window</th><th>tires (bar)</th><th>live data</th></tr>
<tr><td>${car.state}</td><td>${car.battery_level}% · ${Math.round(car.battery_range * 1.609)} km</td><td>${car.charging_state}${car.charger_power ? ` · ${car.charger_power} kW` : ""}</td>
<td>${car.locked}</td><td>${car.windows.rp_window ? "open" : "closed"}</td>
<td>${Object.entries(car.tpms_bar)
    .map(
      ([w, p]) =>
        `${w.toUpperCase()} ${p}${car.tpms_soft[w as "fl"] ? "⚠" : ""}`,
    )
    .join(" ")}</td>
<td>${car.telemetry ? (car.telemetry.synced ? "streaming" : "configured") : "off"}</td></tr></table>
${[
  ["sleep", car.state === "online" ? "Put to sleep" : "Wake (owner opens app)"],
  [
    "plug",
    car.charging_state === "Disconnected" ? "Plug in & charge" : "Unplug",
  ],
  ["drain", "Drive: −10%"],
  ["charge", "Charge: +10%"],
  ["window", car.windows.rp_window ? "Close window" : "Open window"],
  ["lock", car.locked ? "Unlock" : "Lock"],
  ...(car.telemetry ? [["stream", "Stream current state"]] : []),
]
  .map(
    ([action, label]) =>
      `<form class="inline" method="post" action="/__mock/action"><input type="hidden" name="car" value="${index}"><button name="do" value="${action}">${label}</button></form>`,
  )
  .join("")}</div>`;

  async function panel() {
    const identities = [...mock.identities.values()];
    return page(
      "Mock Tesla control panel",
      `<h1>Mock Tesla control panel</h1>
<p><a href="/">Open the dashboard</a> · <a href="/__mock/operator">Open the dashboard as the operator</a> (session from the installation credential, which stays server-side) · Tesla sign-in identities: ${identities.map((i) => escape(i.name)).join(", ")}.</p>
<h2>Cars</h2>${mock.cars.map(carRow).join("")}
<h2>Time and background jobs</h2><div class="card">
${[
  ["time", "6 minutes pass (cached readings expire)"],
  ["tokens", "8 hours pass (access tokens expire)"],
  ["cron", "Run the alert cron now"],
]
  .map(
    ([action, label]) =>
      `<form class="inline" method="post" action="/__mock/action"><button name="do" value="${action}">${label}</button></form>`,
  )
  .join("")}
<p>Alerts go to a mock destination. In the dashboard's alert settings use <code>https://ntfy.sandbox.test/my-topic</code> (ntfy) or <code>https://hooks.sandbox.test/teslabot</code> (JSON).</p></div>
<h2>Notifications received (${mock.inbox.length})</h2><div class="card"><table>${
        mock.inbox
          .slice()
          .reverse()
          .map(
            (m) =>
              `<tr><td>${escape(m.host + m.path)}</td><td><b>${escape(m.title)}</b><br>${escape(m.body)}</td></tr>`,
          )
          .join("") || "<tr><td>None yet.</td></tr>"
      }</table></div>
<h2>Requests that reached “Tesla” (latest 40 of ${mock.log.length})</h2><div class="card"><table>${
        mock.log
          .slice(-40)
          .reverse()
          .map(
            (c) =>
              `<tr><td>${c.n}</td><td>${c.service}</td><td><code>${escape(c.method + " " + redactVins(c.path))}</code></td><td>${c.status}</td><td>${escape(c.identity ?? "")}</td></tr>`,
          )
          .join("") || "<tr><td>None yet.</td></tr>"
      }</table>
<p>Refused (wake, command, unknown host): ${mock.violations.length ? escape(mock.violations.join("; ")) : "none"}</p></div>`,
    );
  }
  const redactVins = (text: string) =>
    mock.cars.reduce(
      (out, car) => out.replaceAll(car.vin, `{VIN:${car.display_name}}`),
      text,
    );

  async function action(form: URLSearchParams) {
    const car = mock.cars[Number(form.get("car"))];
    switch (form.get("do")) {
      case "sleep":
        car.state = car.state === "online" ? "asleep" : "online";
        break;
      case "plug":
        Object.assign(
          car,
          car.charging_state === "Disconnected"
            ? {
                charging_state: "Charging",
                charger_power: 11,
                charge_rate: 30,
                time_to_full_charge: 2,
              }
            : {
                charging_state: "Disconnected",
                charger_power: 0,
                charge_rate: 0,
                time_to_full_charge: 0,
              },
        );
        break;
      case "drain":
      case "charge": {
        const delta = form.get("do") === "drain" ? -10 : 10;
        const level = Math.max(1, Math.min(100, car.battery_level + delta));
        car.battery_range =
          Math.round((car.battery_range / car.battery_level) * level * 10) / 10;
        car.battery_level = level;
        car.usable_battery_level = level - 1;
        if (delta < 0) car.odometer += 20;
        break;
      }
      case "window":
        car.windows.rp_window = car.windows.rp_window ? 0 : 2;
        break;
      case "lock":
        car.locked = !car.locked;
        break;
      case "stream":
        car.telemetry!.synced = true;
        await s.dispatch(ORIGIN + "/telemetry/ingest", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + s.env.TELEMETRY_INGEST_TOKEN,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            records: [
              {
                topic: "tesla_V",
                payload: {
                  vin: car.vin,
                  createdAt: new Date().toISOString(),
                  data: [
                    ["BatteryLevel", { doubleValue: car.battery_level }],
                    ["RatedRange", { doubleValue: car.battery_range }],
                    ["Locked", { booleanValue: car.locked }],
                    ["InsideTemp", { doubleValue: car.inside_temp }],
                    [
                      "RpWindow",
                      {
                        windowStateValue: car.windows.rp_window
                          ? "WindowStateOpened"
                          : "WindowStateClosed",
                      },
                    ],
                  ].map(([key, value]) => ({ key, value })),
                },
              },
            ],
          }),
        });
        break;
      case "time":
        for (const account of await s.accounts()) await s.passTime(account, 6);
        break;
      case "tokens":
        for (const account of await s.accounts())
          await s.expireTokens(account, "");
        for (const identity of mock.identities.keys())
          mock.expireAccessTokens(identity);
        break;
      case "cron":
        await s.scheduled();
        await new Promise((resolve) => setTimeout(resolve, 300));
        break;
    }
  }

  function consentPage(url: URL) {
    const authorize = AUTHORIZE_URL + url.search;
    const { problems, scope } = mock.validateAuthorize(authorize);
    if (problems.length)
      return page(
        "Tesla",
        `<h1>Tesla would refuse this request</h1><p>${escape(problems.join(", "))}</p>`,
      );
    const ticket = crypto.randomUUID();
    pending.set(ticket, authorize);
    return page(
      "Sign in · Mock Tesla",
      `<div class="card" style="max-width:440px;margin:40px auto"><h1>Tesla (mock)</h1>
<p>A third-party application is requesting access to your Tesla account.</p>
<form method="post" action="/__mock/authorize/decision"><input type="hidden" name="ticket" value="${ticket}">
<h2>Sign in as</h2>${[...mock.identities.values()]
        .map(
          (i, n) =>
            `<label><input type="radio" name="identity" value="${i.key}"${n ? "" : " checked"}> ${escape(i.name)} · ${mock.cars.filter((c) => c.owner === i.key).length} car(s)</label>`,
        )
        .join("")}
<h2>Allow</h2>${scope
        .map(
          (sc) =>
            `<label><input type="checkbox" name="scope" value="${escape(sc)}" checked${["openid", "offline_access"].includes(sc) ? " disabled" : ""}> ${escape(sc)}</label>`,
        )
        .join("")}
<p><button class="primary" name="approve" value="1">Allow</button><button name="approve" value="0">Deny</button></p></form></div>`,
    );
  }

  function decision(form: URLSearchParams) {
    const authorize = pending.get(form.get("ticket") ?? "");
    if (!authorize)
      return page(
        "Tesla",
        "<h1>This sign-in expired. Start again from the dashboard.</h1>",
      );
    pending.delete(form.get("ticket")!);
    const requested = mock.validateAuthorize(authorize).scope;
    const kept = new Set([...form.getAll("scope"), "openid", "offline_access"]);
    const callback = mock.consent(authorize, form.get("identity") ?? "owner", {
      approve: form.get("approve") === "1",
      without: requested.filter((sc) => !kept.has(sc)),
    });
    return redirect(callback.slice(ORIGIN.length));
  }

  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", local);
      let response: Response;
      if (url.pathname === "/__mock" || url.pathname === "/__mock/")
        response = await panel();
      else if (url.pathname === "/__mock/operator") {
        const session = await s.dispatch(ORIGIN + "/admin/session", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + s.env.ADMIN_TOKEN,
            Origin: ORIGIN,
          },
        });
        response = redirect("/", session.headers.getSetCookie());
      } else if (url.pathname === "/__mock/action" && req.method === "POST") {
        await action(new URLSearchParams(body.toString()));
        response = redirect("/__mock/");
      } else if (url.pathname === "/__mock/authorize")
        response = consentPage(url);
      else if (
        url.pathname === "/__mock/authorize/decision" &&
        req.method === "POST"
      )
        response = decision(new URLSearchParams(body.toString()));
      else response = await forward(req, body);
      const headers: Record<string, string | string[]> = {};
      response.headers.forEach((value, name) => {
        if (name !== "set-cookie") headers[name] = value;
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) headers["set-cookie"] = cookies;
      res.writeHead(response.status, headers);
      if (response.body) Readable.fromWeb(response.body as never).pipe(res);
      else res.end();
    } catch (error) {
      console.error(error);
      res.writeHead(500).end("sandbox error");
    }
  });
  await new Promise<void>((resolve) =>
    server.listen(port, "localhost", resolve),
  );
  console.log(`
teslabot sandbox running (Worker in workerd, mock Tesla, synthetic cars)

  Dashboard          ${local}/
  Operator session   ${local}/__mock/operator
  Mock Tesla panel   ${local}/__mock/
  Hosted MCP         ${local}/mcp  (mint a credential under "Assistant access")

Location ${location ? "enabled" : "disabled"}. Ctrl-C to stop; all state is discarded.
`);
  const stop = async () => {
    server.close();
    await s.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return { server, sandbox: s as Sandbox, cars: CARS };
}
