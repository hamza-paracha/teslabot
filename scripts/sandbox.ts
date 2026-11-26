// The whole product against a mock Tesla account, in the Workers runtime.
//
//   npx tsx scripts/sandbox.ts             scripted owner + invited-driver journey
//   npx tsx scripts/sandbox.ts --location  same, with ENABLE_LOCATION=true
//   npx tsx scripts/sandbox.ts --serve     interactive: dashboard + mock Tesla
//
// The deployed bundle (wrangler deploy --dry-run) runs in workerd with a local
// D1 database. Tesla OAuth, the Fleet API, the telemetry signer and the
// notification destination are simulated by scripts/lib/mock-tesla.ts; any
// other outbound request is refused and reported. All data is synthetic.
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import type { Client } from "@modelcontextprotocol/client";
import { Browser, ORIGIN, startSandbox, type Sandbox } from "./lib/sandbox";
import { addSandboxWorld, CARS } from "./lib/sandbox-world";
import { serveSandbox } from "./lib/sandbox-server";

const { values } = parseArgs({
  options: {
    serve: { type: "boolean", default: false },
    location: { type: "boolean", default: false },
    port: { type: "string", default: "8787" },
  },
});

if (values.serve) {
  await serveSandbox(Number(values.port), values.location);
} else {
  const failures = await journey(values.location);
  process.exit(failures ? 1 : 0);
}

async function journey(location: boolean) {
  const started = Date.now();
  const s = await startSandbox({ location });
  const { mock, env } = s;
  addSandboxWorld(mock);
  const failures: string[] = [];
  let checks = 0;
  const outputs: unknown[] = [];
  const names = new Map(mock.cars.map((car) => [car.vin, car.display_name]));
  const redact = (text: string) =>
    [...names].reduce(
      (out, [vin, name]) => out.replaceAll(vin, `{VIN:${name}}`),
      text,
    );
  const section = (title: string) => console.log(`\n━━ ${title}`);
  const note = (text: string) => console.log(`    ${redact(text)}`);
  const check = (label: string, ok: unknown, detail?: unknown) => {
    checks++;
    if (!ok) failures.push(label);
    console.log(
      `  ${ok ? "✓" : "✗"} ${label}` +
        (!ok && detail !== undefined
          ? ` — got ${redact(JSON.stringify(detail)).slice(0, 400)}`
          : ""),
    );
  };
  const calls = (mark: number) => mock.since(mark);
  const showCalls = (mark: number) => {
    const list = calls(mark);
    note(
      `Tesla side: ${list.length ? "" : "no requests"}` +
        list
          .map(
            (c) => `\n      ${c.service} ${c.method} ${c.path} → ${c.status}`,
          )
          .join(""),
    );
    return list;
  };
  const fleet = (mark: number, pattern?: RegExp) =>
    calls(mark).filter(
      (c) => c.service === "fleet" && (!pattern || pattern.test(c.path)),
    );
  const secrets = () => [
    ...mock.issued,
    ...mock.cars.map((car) => car.vin),
    env.ADMIN_TOKEN,
    env.MCP_TOKEN,
    env.TESLA_CLIENT_SECRET,
    env.TOKEN_ENCRYPTION_KEY,
    env.TELEMETRY_RELAY_TOKEN,
    env.TELEMETRY_INGEST_TOKEN,
  ];
  const leaks = (value: unknown) => {
    const text = JSON.stringify(value);
    return secrets().filter((secret) => text.includes(secret)).length;
  };
  const tool = async (
    client: Client,
    name: string,
    args: Record<string, unknown> = {},
  ) => {
    const mark = mock.mark();
    const result = await client.callTool({ name, arguments: args });
    outputs.push(result);
    return {
      data: result.structuredContent as any,
      isError: !!result.isError,
      mark,
    };
  };
  const passTime = s.passTime;
  const waitForInbox = async (count: number) => {
    for (let i = 0; i < 50 && mock.inbox.length < count; i++)
      await new Promise((resolve) => setTimeout(resolve, 100));
  };
  const juniper = mock.car(CARS.juniper);
  const iso = (offsetMinutes: number) =>
    new Date(Date.now() + offsetMinutes * 60000).toISOString();

  try {
    section("0. Boot: deployed bundle in workerd, local D1, mock Tesla");
    note(
      `Config as deployed: region na, location ${location ? "ON" : "off"}, 50 Tesla requests/day, $5/month cap, 300 s cache, commands and wake disabled.`,
    );
    const anon = new Browser(s);
    const health = await anon.go("/health");
    check("GET /health is ok and read-only", health.body?.mode === "read_only");
    const key = await anon.go(
      "/.well-known/appspecific/com.tesla.3p.public-key.pem",
    );
    check(
      "Tesla partner public key is served",
      String(key.body).includes("BEGIN PUBLIC KEY"),
    );
    check(
      "dashboard page is served",
      String((await anon.go("/")).body).includes("teslabot"),
    );
    check(
      "account status needs a session (401)",
      (await anon.go("/auth/status")).status === 401,
    );
    check(
      "/mcp needs a bearer credential (401)",
      (await anon.go("/mcp", { method: "POST", body: {} })).status === 401,
    );

    section("1. Alex (operator) opens the dashboard and connects Tesla");
    const alex = new Browser(s);
    const session = await alex.go("/admin/session", {
      method: "POST",
      bearer: env.ADMIN_TOKEN,
    });
    check(
      "operator credential opens a one-hour session cookie",
      session.status === 200 && alex.jar.has("__Host-ev_session"),
    );
    let status = (await alex.go("/auth/status")).body;
    check(
      "status: operator, Tesla app configured, not connected",
      status.role === "operator" && status.configured && !status.connected,
      status,
    );
    let mark = mock.mark();
    const login = await alex.go("/auth/login", { navigate: true });
    const authorize = mock.validateAuthorize(login.location ?? "");
    check(
      "Connect redirects to Tesla's authorize page with a valid request",
      login.status === 303 && !authorize.problems.length,
      authorize.problems,
    );
    note(`requested scopes: ${authorize.scope.join(" ")}`);
    check(
      "asks for a fresh Tesla login (prompt=login)",
      authorize.params.get("prompt") === "login",
    );
    check(
      `location scope ${location ? "requested" : "not requested"}`,
      authorize.scope.includes("vehicle_location") === location,
    );
    const callback = mock.consent(login.location!, "owner");
    const connected = await alex.go(callback.replace(ORIGIN, ""), {
      navigate: true,
    });
    check(
      "Tesla callback exchanges the code and lands on /?oauth=connected",
      connected.location === "/?oauth=connected",
      connected,
    );
    const replay = await alex.go(callback.replace(ORIGIN, ""), {
      navigate: true,
    });
    check(
      "replaying the callback is refused",
      replay.location?.includes("oauth_error="),
      replay,
    );
    note(`replay landed on ${replay.location}`);
    showCalls(mark);
    status = (await alex.go("/auth/status")).body;
    check(
      "status: connected, Vehicle Information granted, car not yet selected",
      status.connected &&
        status.authorization.vehicle_information === "granted" &&
        !status.vehicle_selected,
      status,
    );

    section("2. Alex adds an assistant before choosing a car");
    const minted = (
      await alex.go("/account/mcp-tokens", {
        method: "POST",
        body: { label: "Sandbox assistant" },
      })
    ).body;
    check(
      "assistant credential minted (tbm_…) with the hosted /mcp endpoint",
      minted.token?.startsWith("tbm_") && minted.endpoint === ORIGIN + "/mcp",
      minted,
    );
    const assistant = await s.mcp(minted.token);
    const listed = (await assistant.listTools()).tools;
    check(
      "hosted MCP lists the 8 tools",
      listed.length === 8,
      listed.map((t) => t.name),
    );
    check(
      "no tool is marked destructive",
      listed.every((t) => t.annotations?.destructiveHint === false),
    );
    note(
      "tools: " +
        listed
          .map(
            (t) => t.name + (t.annotations?.readOnlyHint ? "" : " (planner)"),
          )
          .join(", "),
    );
    let r = await tool(assistant, "tesla_get_snapshot");
    const viaHttp = await anon.go("/api/vehicle/context", {
      bearer: minted.token,
    });
    note(
      `same request over HTTP: ${viaHttp.status} ${viaHttp.body?.error?.code}`,
    );
    check(
      "snapshot before selection explains select_vehicle_first (as over HTTP)",
      r.isError && r.data?.error?.code === "select_vehicle_first",
      r.data,
    );

    section("3. Alex loads vehicles and selects one");
    mark = mock.mark();
    const vehicles = (await alex.go("/api/vehicles?refresh=true")).body;
    check(
      "two authorized cars, each with an opaque id (no VIN)",
      vehicles.vehicles?.length === 2 && leaks(vehicles) === 0,
      vehicles,
    );
    for (const v of vehicles.vehicles ?? [])
      note(`${v.display_name} · ${v.state} · id ${v.id}`);
    check(
      "a sole selection is required explicitly",
      vehicles.status === "selection_required",
    );
    const bogus = await alex.go("/api/vehicle/select", {
      method: "POST",
      body: { id: randomBytes(12).toString("hex") },
    });
    check(
      "selecting an unknown id is refused",
      bogus.status === 403 &&
        bogus.body.error.code === "vehicle_not_authorized",
      bogus.body,
    );
    const juniperId = vehicles.vehicles.find(
      (v: any) => v.display_name === "Juniper",
    ).id;
    const selected = await alex.go("/api/vehicle/select", {
      method: "POST",
      body: { id: juniperId },
    });
    check("Juniper selected", selected.body?.selected === true, selected.body);
    check(
      "loading and selecting read metadata only (no vehicle_data, no wake)",
      fleet(mark, /vehicle_data|wake/).length === 0,
    );

    section("4. Dashboard: Refresh Vehicle Data");
    mark = mock.mark();
    const context = (await alex.go("/api/vehicle/context")).body;
    showCalls(mark);
    const obs = context.observation;
    check(
      "one vehicle check + one vehicle_data read",
      fleet(mark).length === 2 && fleet(mark, /vehicle_data/).length === 1,
    );
    check(
      `vehicle_data ${location ? "includes" : "excludes"} location_data`,
      fleet(mark, /location_data/).length === (location ? 1 : 0),
    );
    check(
      "battery 46%, range ≈ 228 km, unplugged",
      obs?.battery.percentage === 46 &&
        Math.round(obs.battery.range_km) === 228 &&
        obs.charging.connected === false,
      obs?.battery,
    );
    check(
      "rear passenger window reported open; rear-left tire soft warning",
      obs?.closures.windows.passenger_rear === true &&
        obs.tires.rear_left.soft_warning === true,
    );
    check(
      "software version and odometer normalized",
      obs?.vehicle.software_version &&
        Math.round(obs.vehicle.odometer_km) === 29520,
      obs?.vehicle,
    );
    note(`narrative: ${context.narrative}`);
    mark = mock.mark();
    const again = (await alex.go("/api/vehicle/context")).body;
    check(
      "second refresh within 5 minutes is a cache hit with no Tesla request",
      again.observation.data.cache_hit === true && calls(mark).length === 0,
    );

    section("5. Assistant: “How's the car?”");
    r = await tool(assistant, "tesla_get_vehicles");
    check(
      "tesla_get_vehicles: ready, Juniper selected",
      r.data.status === "ready" && r.data.selected_id === juniperId,
      r.data,
    );
    r = await tool(assistant, "tesla_get_snapshot");
    const snap = r.data;
    check(
      "tesla_get_snapshot: served from cache, no Tesla request",
      snap.data?.cache_hit === true && calls(r.mark).length === 0,
      snap.data,
    );
    check(
      "readiness flags the open window and the tire warning",
      snap.readiness?.assessment === "attention_needed" &&
        snap.readiness.attention.map((a: any) => a.code).join() ===
          "windows_passenger_rear_open,tire_rear_left_soft_warning",
      snap.readiness?.attention,
    );
    note(`narrative: ${snap.narrative}`);
    note(
      `tires (psi): FL ${snap.tires.front_left.pressure_psi} · FR ${snap.tires.front_right.pressure_psi} · RL ${snap.tires.rear_left.pressure_psi} · RR ${snap.tires.rear_right.pressure_psi}`,
    );
    r = await tool(assistant, "tesla_get_snapshot", {
      sections: ["battery", "location"],
    });
    check(
      location
        ? "location section returned"
        : "location requested but reported unavailable (disabled)",
      location
        ? r.data.location?.latitude === juniper.latitude
        : r.data.location === null &&
            r.data.unavailable_sections?.includes("location"),
      r.data,
    );
    mark = mock.mark();
    const burst = await Promise.all(
      Array.from({ length: 5 }, () => tool(assistant, "tesla_get_snapshot")),
    );
    check(
      "5 parallel snapshots: all succeed from cache, zero Tesla requests",
      burst.every((b) => !b.isError && b.data.data.cache_hit) &&
        calls(mark).length === 0,
    );

    section("6. Assistant: “Can I make it to Blue Mountain and back?”");
    r = await tool(assistant, "tesla_plan_trip", {
      origin: "Home",
      destination: "Blue Mountain",
      route_source: "sandbox fixed distances",
      legs: [{ to: "Blue Mountain", distance_km: 165 }],
      return_distance_km: 165,
      reserve_percentage: 20,
    });
    const trip = r.data;
    const legs = (plan: any) =>
      (plan.legs ?? [])
        .map((l: any) => `${l.to} ${l.estimated_arrival_percentage}%`)
        .join(" → ");
    note(
      `${trip.assessment}: leave with ${trip.start_percentage}% → ${legs(trip)}; minimum departure ${trip.minimum_departure_percentage}%, shortfall ${trip.shortfall_percentage}%`,
    );
    check(
      "round trip at 46% is short; plan saved with a trip_id",
      /^[a-f0-9]{24}$/.test(trip.trip_id) && trip.shortfall_percentage > 0,
      trip,
    );
    r = await tool(assistant, "tesla_plan_trip", {
      trip_id: trip.trip_id,
      charging: {
        usable_capacity_kwh: 75,
        charger_power_kw: 11,
        available_minutes: 120,
      },
    });
    note(
      `“I can plug in at home for 2 hours”: ${JSON.stringify(r.data.charging)}`,
    );
    check(
      "follow-up keeps the route and adds a charging window",
      r.data.trip_id === trip.trip_id && r.data.charging != null,
      r.data,
    );
    r = await tool(assistant, "tesla_plan_trip", {
      trip_id: trip.trip_id,
      legs: [{ to: "Collingwood", distance_km: 75 }],
      return_distance_km: 75,
      reserve_percentage: 10,
      charging: null,
    });
    note(
      `“Just Collingwood, 10% reserve”: ${r.data.assessment}, ${legs(r.data)}, shortfall ${r.data.shortfall_percentage}%`,
    );
    check(
      "shorter trip is feasible from 46%",
      r.data.shortfall_percentage === 0,
      r.data,
    );
    check(
      "three planning calls made no Tesla request",
      calls(trip ? r.mark : 0).length === 0,
    );

    section("7. Assistant: charging cost to 80%");
    r = await tool(assistant, "tesla_plan_charging", {
      target_percentage: 80,
      usable_capacity_kwh: 75,
      charger_power_kw: 11,
      electricity_price_per_kwh: 0.13,
      currency: "CAD",
    });
    note(JSON.stringify(r.data).slice(0, 400));
    check("charging plan returned", !r.isError, r.data);

    section("8. Assistant: tomorrow's calendar + forecast");
    r = await tool(assistant, "tesla_plan_departures", {
      events: [
        {
          id: "evt-ski",
          title: "Ski day at Blue Mountain",
          starts_at: iso(18 * 60),
          location: "Blue Mountain",
          travel_mode: "driving",
          travel_minutes: 120,
          total_distance_km: 330,
        },
      ],
      departure_forecast: {
        source: "sandbox forecast",
        location_label: "Home",
        issued_at: iso(0),
        hours: [{ at: iso(16 * 60), temperature_c: -9 }],
      },
    });
    const plan = r.data.plans?.[0];
    note(
      `leave at ${plan?.departure_at}; trip check: ${plan?.trip?.assessment}`,
    );
    for (const proposal of plan?.proposals ?? [])
      note(
        `proposal (at departure − 20 min): ${proposal.kind} — ${proposal.message}`,
      );
    for (const due of r.data.briefing?.suggestions ?? [])
      note(`due now: ${due.kind} — ${due.message}`);
    check(
      "cold departure → preconditioning offer; 330 km at 46% → charge review due now",
      plan?.proposals.some(
        (p: any) => p.kind === "offer_cabin_preconditioning",
      ) &&
        plan.trip?.assessment === "charging_recommended" &&
        r.data.briefing.suggestions.some(
          (p: any) => p.kind === "review_trip_charge",
        ),
      r.data,
    );
    check(
      "departure planning never executes anything",
      r.data.actions_executed === false,
    );

    section(
      "9. Assistant hands two drives to teslabot for server-side briefings",
    );
    r = await tool(assistant, "tesla_schedule_briefings", {
      events: [
        {
          event_id: "evt-dentist",
          title: "Dentist",
          departs_at: iso(20),
          total_distance_km: 24,
        },
        {
          event_id: "evt-ski",
          title: "Ski day",
          departs_at: iso(16 * 60),
          total_distance_km: 330,
        },
      ],
    });
    check(
      "both scheduled; delivery inactive until alerts are enabled",
      r.data.briefings?.length === 2 && r.data.delivery?.active === false,
      r.data,
    );
    note(`delivery: ${r.data.delivery?.guidance}`);

    section("10. History opt-in");
    r = await tool(assistant, "tesla_get_history");
    check(
      "history is off by default",
      r.data.enabled === false && r.data.observations.length === 0,
    );
    const prefs = await alex.go("/admin/preferences", {
      method: "POST",
      body: {
        history_enabled: true,
        battery_change_percentage: 5,
        temperature_change_c: 3,
      },
    });
    check("Alex turns history on", prefs.body.history_enabled === true);

    section("11. Six minutes later: plugged in, window closed, cabin warming");
    Object.assign(juniper, {
      charging_state: "Charging",
      charger_power: 11,
      charge_rate: 30,
      time_to_full_charge: 2.5,
      charge_energy_added: 4.6,
      battery_level: 52,
      usable_battery_level: 51,
      battery_range: 160.7,
      inside_temp: 18.5,
      is_climate_on: true,
    });
    juniper.windows.rp_window = 0;
    await passTime("", 6);
    r = await tool(assistant, "tesla_get_snapshot");
    showCalls(r.mark);
    check(
      "expired cache → one fresh read",
      r.data.data.cache_hit === false &&
        fleet(r.mark, /vehicle_data/).length === 1,
    );
    note(`changes: ${JSON.stringify(r.data.changes)}`);
    check(
      "changes since last reading include battery and charging",
      JSON.stringify(r.data.changes).includes("battery") &&
        JSON.stringify(r.data.changes).includes("charg"),
      r.data.changes,
    );
    check(
      "readiness now only flags the tire",
      r.data.readiness.attention.length === 1,
      r.data.readiness.attention,
    );
    note(`narrative: ${r.data.narrative}`);
    r = await tool(assistant, "tesla_get_history");
    check(
      "history kept the new observation",
      r.data.observations.length === 1,
      r.data,
    );

    section("12. The car falls asleep");
    juniper.state = "asleep";
    await passTime("", 6);
    mark = mock.mark();
    const asleep = await Promise.all(
      Array.from({ length: 5 }, () => tool(assistant, "tesla_get_snapshot")),
    );
    showCalls(mark);
    check(
      "5 parallel reads share one Tesla check, get the last reading flagged stale",
      fleet(mark).length === 1 &&
        asleep.every(
          (a) =>
            a.data.battery?.percentage === 52 &&
            a.data.data.is_stale &&
            a.data.data.refresh_error === "vehicle_asleep",
        ),
      asleep.map((a) => a.data.data),
    );
    check(
      "no vehicle_data and no wake while asleep",
      fleet(mark, /vehicle_data|wake/).length === 0 && !mock.violations.length,
    );
    r = await tool(assistant, "tesla_plan_trip", { trip_id: trip.trip_id });
    note(
      `trip with a 12-minute-old reading: ${r.data.assessment} · start ${r.data.start_percentage} · ${(r.data.missing_context ?? []).join("; ")}`,
    );
    check(
      "planner withholds the estimate on stale data",
      r.data.start_percentage === null,
      r.data,
    );

    section(
      "13. Eight hours on: access token expired, Alex opens the Tesla app",
    );
    juniper.state = "online";
    const ownerStore = s.store("");
    const before = await s.expireTokens("", "owner");
    await passTime("", 60);
    r = await tool(assistant, "tesla_get_snapshot", { sections: ["battery"] });
    const refreshCalls = showCalls(r.mark);
    check(
      "teslabot refreshes the token first, then reads with the new one",
      refreshCalls[0]?.path === "/oauth2/v3/token" &&
        refreshCalls[0].status === 200 &&
        refreshCalls.every((c) => c.status === 200) &&
        r.data.battery?.percentage === 52,
      refreshCalls,
    );
    const after = await ownerStore.get<any>("owner_tokens");
    check(
      "rotated refresh token stored; the old one is spent",
      after.refresh_token !== before.refresh_token,
    );

    section("14. Alex drove the trip and reports back");
    r = await tool(assistant, "tesla_record_trip_outcome", {
      trip_id: trip.trip_id,
      start_percentage: 80,
      actual_end_percentage: 52,
    });
    note(
      `predicted ${r.data.outcome?.predicted_used_percentage}% used, actual ${r.data.outcome?.actual_used_percentage}%; ${JSON.stringify(r.data.calibration)}`,
    );
    check(
      "trip outcome recorded",
      r.data.outcome?.trip_id === trip.trip_id,
      r.data,
    );

    section(
      "15. Alerts: ntfy destination, plug-in reminder, departure briefing",
    );
    const topic = "teslabot-" + randomBytes(6).toString("hex");
    const alerts = await alex.go("/admin/alerts", {
      method: "POST",
      body: {
        enabled: true,
        time_zone: "America/Toronto",
        notify: { format: "ntfy", url: `https://ntfy.sandbox.test/${topic}` },
        plug_in: { enabled: true, local_hour: 0, below_percentage: 60 },
        briefings: {
          enabled: true,
          lead_minutes: 45,
          reserve_percentage: 20,
          only_when_tight: false,
        },
      },
    });
    check(
      "saved; the dashboard sees only the destination host",
      alerts.body.settings?.notify?.host === "ntfy.sandbox.test" &&
        !JSON.stringify(alerts.body).includes(topic),
      alerts.body,
    );
    note(
      "plug-in hour set to 0 so the reminder is due whenever this runs (default 21)",
    );
    await alex.go("/admin/alerts/test", { method: "POST" });
    check(
      "test notification delivered",
      mock.inbox.at(-1)?.title === "teslabot test",
    );
    Object.assign(juniper, {
      charging_state: "Disconnected",
      charger_power: 0,
      charge_rate: 0,
      time_to_full_charge: 0,
      battery_level: 44,
      usable_battery_level: 43,
      battery_range: 135.5,
      is_climate_on: false,
    });
    await passTime("", 6);
    const inboxBefore = mock.inbox.length;
    mark = mock.mark();
    await s.scheduled();
    await waitForInbox(inboxBefore + 2);
    showCalls(mark);
    const sent = mock.inbox.slice(inboxBefore);
    for (const message of sent)
      note(
        `📨 ${message.title}\n        ${message.body.replace(/\n/g, "\n        ")}`,
      );
    check(
      "cron sent the plug-in reminder and the dentist briefing",
      sent.length === 2,
      sent,
    );
    const quiet = mock.inbox.length;
    await s.scheduled();
    await new Promise((resolve) => setTimeout(resolve, 500));
    check(
      "running the cron again sends nothing new",
      mock.inbox.length === quiet,
    );
    await tool(assistant, "tesla_schedule_briefings", {
      events: [
        {
          event_id: "evt-dentist",
          title: "Dentist (moved)",
          departs_at: iso(30),
          total_distance_km: 24,
        },
      ],
    });
    await s.scheduled();
    await waitForInbox(quiet + 1);
    check(
      "moving the appointment re-arms its briefing",
      mock.inbox.length === quiet + 1 &&
        mock.inbox.at(-1)!.body.includes("Dentist (moved)"),
      mock.inbox.slice(quiet),
    );
    r = await tool(assistant, "tesla_schedule_briefings", {
      events: [
        {
          event_id: "evt-dentist",
          title: "Dentist",
          departs_at: iso(30),
          cancelled: true,
        },
      ],
    });
    check(
      "cancelling drops it; the ski day remains",
      r.data.briefings.length === 1 &&
        r.data.briefings[0].event_id === "evt-ski" &&
        r.data.delivery.active === true,
      r.data,
    );
    const alertState = (await alex.go("/admin/alerts")).body.state;
    check(
      "alert state: last sent recorded, no delivery error",
      alertState.last_sent_at && !alertState.last_error,
      alertState,
    );

    section("16. Live data (Fleet Telemetry)");
    status = (await alex.go("/auth/status")).body;
    check(
      "telemetry available in this installation",
      status.telemetry_available,
    );
    mark = mock.mark();
    const enabled = await alex.go("/api/telemetry/enable", { method: "POST" });
    showCalls(mark);
    check(
      "enable: config signed and pushed for Juniper",
      enabled.body.enabled === true && juniper.telemetry !== null,
      enabled.body,
    );
    const pushed = juniper.telemetry?.config as any;
    note(
      `config: ${pushed?.hostname}:${pushed?.port}, ${Object.keys(pushed?.fields ?? {}).length} signals, expires ${new Date((pushed?.exp ?? 0) * 1000).toISOString().slice(0, 10)}`,
    );
    juniper.telemetry!.synced = true;
    const tcheck = (await alex.go("/api/telemetry?check=true")).body;
    check(
      "check=true reads Tesla's view: synced, key paired",
      tcheck.tesla?.synced === true && tcheck.tesla.key_paired === true,
      tcheck,
    );
    const relay = (records: unknown[]) =>
      anon.go("/telemetry/ingest", {
        method: "POST",
        bearer: env.TELEMETRY_INGEST_TOKEN,
        body: { records },
      });
    const v = (at: number, data: Record<string, unknown>) => ({
      topic: "tesla_V",
      payload: {
        vin: CARS.juniper,
        createdAt: iso(at),
        data: Object.entries(data).map(([key, value]) => ({ key, value })),
      },
    });
    const live = [
      {
        topic: "tesla_connectivity",
        payload: {
          vin: CARS.juniper,
          connectionId: "sandbox",
          status: "CONNECTED",
          createdAt: iso(0),
          networkInterface: "wifi",
        },
      },
      v(0, {
        BatteryLevel: { doubleValue: 41 },
        RatedRange: { doubleValue: 126.4 },
        DetailedChargeState: {
          detailedChargeStateValue: "DetailedChargeStateDisconnected",
        },
        Locked: { booleanValue: false },
        InsideTemp: { doubleValue: 9 },
      }),
    ];
    let ingest = (await relay(live)).body;
    check("relay batch applied", ingest.applied === 1, ingest);
    ingest = (await relay([v(-5, { BatteryLevel: { doubleValue: 60 } })])).body;
    check("an older, late record is ignored", ingest.ignored === 1, ingest);
    ingest = (await relay(live)).body;
    check("a re-sent batch is ignored", ingest.applied === 0, ingest);
    ingest = (
      await relay([
        { topic: "tesla_V", payload: { vin: CARS.stranger, data: [] } },
      ])
    ).body;
    check(
      "an unknown car is counted, not stored",
      ingest.unknown_vehicles === 1,
      ingest,
    );
    r = await tool(assistant, "tesla_get_snapshot", {
      sections: ["battery", "readiness"],
    });
    check(
      "snapshot reflects streamed data (41%, unlocked) with zero Tesla polling",
      r.data.battery?.percentage === 41 &&
        r.data.readiness.attention.some(
          (a: any) => a.code === "vehicle_unlocked",
        ) &&
        calls(r.mark).length === 0,
      { battery: r.data.battery, calls: calls(r.mark) },
    );
    check(
      "the relay credential cannot read vehicle data",
      (
        await anon.go("/api/vehicle/battery", {
          bearer: env.TELEMETRY_INGEST_TOKEN,
        })
      ).status === 403,
    );
    check(
      "the assistant credential cannot change telemetry",
      (
        await anon.go("/api/telemetry/enable", {
          method: "POST",
          bearer: minted.token,
        })
      ).status === 403,
    );

    section("17. Alex invites Sam");
    const invite = (
      await alex.go("/admin/invites", {
        method: "POST",
        body: { label: "Sam", days: 7 },
      })
    ).body;
    const code = new URL(invite.invite_url).searchParams.get("invite")!;
    check(
      "single-use invite link created",
      /^[a-f0-9]{32,64}$/.test(code),
      invite,
    );
    const stranger = new Browser(s);
    let start = await stranger.go("/auth/signin", { navigate: true });
    let back = await stranger.go(
      mock.consent(start.location!, "stranger").replace(ORIGIN, ""),
      { navigate: true },
    );
    check(
      "a Tesla account without an invite is turned away",
      back.location === "/?oauth_error=invite_required",
      back,
    );
    const sam = new Browser(s);
    start = await sam.go("/auth/signup?invite=" + code, { navigate: true });
    back = await sam.go(
      mock.consent(start.location!, "sam").replace(ORIGIN, ""),
      {
        navigate: true,
      },
    );
    check(
      "Sam accepts with Tesla and lands connected",
      back.location === "/?oauth=connected",
      back,
    );
    check(
      "the invite cannot be reused",
      (await stranger.go("/auth/signup?invite=" + code)).status === 403,
    );
    const samStatus = (await sam.go("/auth/status")).body;
    check(
      "Sam is a driver, connected",
      samStatus.role === "user" && samStatus.connected,
      samStatus,
    );
    const samCars = (await sam.go("/api/vehicles?refresh=true")).body;
    check(
      "Sam sees only his own car",
      samCars.vehicles.length === 1 &&
        samCars.vehicles[0].display_name === "Sam's Model 3",
      samCars,
    );
    check(
      "Sam cannot select Alex's car",
      (
        await sam.go("/api/vehicle/select", {
          method: "POST",
          body: { id: juniperId },
        })
      ).status === 403,
    );
    await sam.go("/api/vehicle/select", {
      method: "POST",
      body: { id: samCars.vehicles[0].id },
    });
    mark = mock.mark();
    const samBattery = (await sam.go("/api/vehicle/battery")).body;
    check(
      "Sam's car hides private data, so location is never requested for it",
      fleet(mark, /vehicle_data/).length === 1 &&
        fleet(mark, /location_data/).length === 0,
    );
    check(
      "Sam reads his battery (64%)",
      samBattery.battery?.percentage === 64,
      samBattery,
    );
    check(
      "Sam has no operator pages",
      (await sam.go("/admin/invites")).status === 403,
    );
    const samToken = (
      await sam.go("/account/mcp-tokens", {
        method: "POST",
        body: { label: "Sam's assistant" },
      })
    ).body.token;
    const samAssistant = await s.mcp(samToken, "sam-assistant");
    const samSnap = (
      await tool(samAssistant, "tesla_get_snapshot", { sections: ["battery"] })
    ).data;
    const alexSnap = (
      await tool(assistant, "tesla_get_snapshot", { sections: ["battery"] })
    ).data;
    check(
      "each assistant sees only its own driver's car",
      samSnap.vehicle?.display_name === "Sam's Model 3" &&
        alexSnap.vehicle?.display_name === "Juniper",
      { samSnap, alexSnap },
    );
    const accounts = (await alex.go("/admin/accounts")).body.accounts;
    note(
      "accounts: " +
        accounts
          .map(
            (a: any) =>
              `${a.owner ? "owner" : a.label} (${a.connected ? "connected" : "not connected"}${a.telemetry ? ", live data" : ""})`,
          )
          .join(", "),
    );
    check("operator sees both accounts", accounts.length === 2);

    section("18. Alex only uses Sign in with Tesla");
    const teslaSignIn = async (identity: string) => {
      const browser = new Browser(s);
      const begin = await browser.go("/auth/signin", { navigate: true });
      const landed = await browser.go(
        mock.consent(begin.location!, identity).replace(ORIGIN, ""),
        { navigate: true },
      );
      const state = (await browser.go("/auth/status")).body;
      return { browser, landed: landed.location, state };
    };
    let phone = await teslaSignIn("owner");
    note(
      `signed in: role=${phone.state.role}, connected=${phone.state.connected}, selected=${phone.state.vehicle_selected}`,
    );
    check(
      "the owner's Tesla account opens the operator dashboard",
      phone.landed === "/?oauth=connected" &&
        phone.state.role === "operator" &&
        phone.state.vehicle_selected &&
        (await phone.browser.go("/admin/invites")).status === 200,
      phone,
    );
    // An installation connected before Tesla sign-in existed has no link yet.
    await s.DB.prepare(
      "UPDATE accounts SET tesla_sub_hash=NULL WHERE id=''",
    ).run();
    const intruder = await teslaSignIn("stranger");
    check(
      "an unlinked owner account cannot be claimed by another Tesla account",
      intruder.landed === "/?oauth_error=invite_required",
      intruder.landed,
    );
    phone = await teslaSignIn("owner");
    check(
      "the connected Tesla account claims it on first sign-in, as operator",
      phone.state.role === "operator" &&
        (
          await s.DB.prepare(
            "SELECT tesla_sub_hash FROM accounts WHERE id=''",
          ).first<any>()
        ).tesla_sub_hash,
      phone.state,
    );

    section("19. Leaving: Sam deletes his account, Alex disconnects");
    const samDeleted = await sam.go("/account/delete", { method: "POST" });
    check(
      "Sam deletes his account",
      samDeleted.body.deleted === true,
      samDeleted.body,
    );
    const samRows = (
      await s.DB.prepare(
        "SELECT COUNT(*) AS n FROM records WHERE key LIKE 'acct:%'",
      ).first<any>()
    ).n;
    check("none of Sam's records remain", samRows === 0, samRows);
    check(
      "Sam's assistant credential stops working",
      (await anon.go("/api/vehicle/battery", { bearer: samToken })).status ===
        401,
    );
    mark = mock.mark();
    const bye = await alex.go("/auth/disconnect", { method: "POST" });
    showCalls(mark);
    check("Alex disconnects", bye.body.disconnected === true, bye.body);
    check(
      "disconnect also removes the telemetry config from the car",
      juniper.telemetry === null,
      { tesla_side_config_still_present: juniper.telemetry !== null },
    );
    check(
      "the dashboard session ends",
      (await alex.go("/auth/status")).status === 401,
    );
    r = await tool(assistant, "tesla_get_snapshot");
    const afterHttp = await anon.go("/api/vehicle/context", {
      bearer: minted.token,
    });
    note(
      `assistant after disconnect: ${r.data?.error?.code}; over HTTP: ${afterHttp.body?.error?.code}`,
    );
    check(
      "the assistant is told the account is disconnected",
      r.isError && r.data?.error?.code === "tesla_not_connected",
      r.data,
    );
    ingest = (await relay([v(0, { BatteryLevel: { doubleValue: 40 } })])).body;
    check(
      "a record already in flight after disconnect is dropped",
      ingest.unknown_vehicles === 1 && ingest.applied === 0,
      ingest,
    );
    phone = await teslaSignIn("owner");
    check(
      "Sign in with Tesla alone reconnects the owner (car selection required again)",
      phone.state.role === "operator" &&
        phone.state.connected &&
        !phone.state.vehicle_selected,
      phone.state,
    );

    section("20. Invariants across the whole run");
    check(
      "no wake, command or unknown-host request reached the network",
      !mock.violations.length,
      mock.violations,
    );
    check(
      "no tool output contains a VIN, Tesla token or installation secret",
      outputs.every((o) => leaks(o) === 0),
    );
    const tables = [
      "records",
      "sessions",
      "oauth_states",
      "mcp_tokens",
      "invites",
      "usage",
      "audit",
      "accounts",
      "telemetry_vehicles",
    ];
    let plain = 0;
    for (const table of tables) {
      const { results } = await s.DB.prepare(`SELECT * FROM ${table}`).all();
      plain += leaks(results);
    }
    check("D1 holds no plaintext token, secret or VIN", plain === 0, plain);
    const byService = mock.log.reduce<Record<string, number>>(
      (n, c) => ((n[c.service] = (n[c.service] ?? 0) + 1), n),
      {},
    );
    note(`all simulated upstream traffic: ${JSON.stringify(byService)}`);
    const usage = await s.DB.prepare(
      "SELECT account, category, SUM(count) AS requests, SUM(estimated_usd) AS usd FROM usage GROUP BY account, category",
    ).all();
    note(`metered Fleet API usage: ${JSON.stringify(usage.results)}`);
    const errors = s.logs.filter((line) => line.startsWith("error"));
    check("no Worker errors logged", !errors.length, errors);
    await assistant.close();
    await samAssistant.close();
  } catch (error) {
    failures.push("crashed: " + (error as Error).stack);
    console.error(error);
  } finally {
    await s.close();
  }
  console.log(
    `\n${checks - failures.length}/${checks} checks passed in ${((Date.now() - started) / 1000).toFixed(1)} s` +
      (failures.length ? `\nFailed:\n  - ${failures.join("\n  - ")}` : "") +
      "\nSynthetic data only: mock Tesla accounts and cars, no credentials or network.\n",
  );
  return failures.length;
}
