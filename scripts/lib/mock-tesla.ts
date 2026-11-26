import { randomBytes, randomUUID } from "node:crypto";
import { regions, TOKEN_URL } from "../../src/tesla/auth";

// Everything teslabot talks to outside the Worker, simulated in memory: Tesla's
// consent page and token endpoint, the Fleet API, the telemetry signing Worker
// and notification destinations. Every request is logged, and anything the
// mock does not recognise is refused and recorded, so a run shows exactly what
// would have reached Tesla. Nothing here touches the network.

export const AUTHORIZE_URL = "https://auth.tesla.com/oauth2/v3/authorize";
export const NOTIFY_HOSTS = ["ntfy.sandbox.test", "hooks.sandbox.test"];
const FLEET = regions.na;

export interface Identity {
  key: string;
  sub: string;
  name: string;
}
export type CarState = "online" | "asleep" | "offline";
// The car's physical state, in Tesla's units (miles, bar, Celsius).
export interface Car {
  owner: string;
  vin: string;
  id: number;
  vehicle_id: number;
  display_name: string;
  model: string;
  state: CarState;
  key_paired: boolean;
  hide_private: boolean;
  battery_level: number;
  usable_battery_level: number;
  battery_range: number;
  charging_state: string;
  charger_power: number;
  charge_limit_soc: number;
  charge_energy_added: number;
  charge_rate: number;
  time_to_full_charge: number;
  inside_temp: number;
  outside_temp: number;
  is_climate_on: boolean;
  locked: boolean;
  sentry_mode: boolean;
  car_version: string;
  odometer: number;
  doors: { df: number; dr: number; pf: number; pr: number };
  trunks: { ft: number; rt: number };
  windows: {
    fd_window: number;
    fp_window: number;
    rd_window: number;
    rp_window: number;
  };
  tpms_bar: { fl: number; fr: number; rl: number; rr: number };
  tpms_soft: { fl: boolean; fr: boolean; rl: boolean; rr: boolean };
  tpms_hard: { fl: boolean; fr: boolean; rl: boolean; rr: boolean };
  latitude: number;
  longitude: number;
  heading: number;
  telemetry: { config: unknown; synced: boolean } | null;
}
export interface LogEntry {
  n: number;
  service: "auth" | "fleet" | "signer" | "notify" | "blocked";
  method: string;
  path: string;
  status: number;
  identity?: string;
}
export interface Delivery {
  host: string;
  path: string;
  format: "ntfy" | "json";
  title: string | null;
  body: string;
}
interface Grant {
  identity: string;
  scope: string[];
}

const b64url = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
// Tesla issues JWTs; teslabot reads their claims but the mock does not sign them.
const jwt = (claims: Record<string, unknown>) =>
  `${b64url({ alg: "RS256", typ: "JWT", kid: "sandbox" })}.${b64url(claims)}.sandbox-unsigned`;
const opaque = (prefix: string) =>
  prefix + randomBytes(24).toString("base64url");

export class MockTesla {
  readonly identities = new Map<string, Identity>();
  readonly cars: Car[] = [];
  readonly log: LogEntry[] = [];
  readonly inbox: Delivery[] = [];
  // Requests that must never happen: wakes, commands, unknown hosts, misuse.
  readonly violations: string[] = [];
  // Every credential the mock issued, so outputs can be scanned for leaks.
  readonly issued = new Set<string>();
  private codes = new Map<
    string,
    Grant & { redirect_uri: string; expires: number; used: boolean }
  >();
  private access = new Map<string, Grant & { expires: number }>();
  private refresh = new Map<string, Grant & { used: boolean }>();

  constructor(
    readonly app: {
      origin: string;
      client_id: string;
      client_secret: string;
      relay_token: string;
    },
    // Lifetime of issued access tokens; Tesla's are eight hours.
    readonly accessSeconds = 28800,
  ) {}

  addIdentity(key: string, name: string) {
    this.identities.set(key, { key, sub: randomUUID(), name });
  }
  addCar(car: Omit<Car, "id" | "vehicle_id" | "telemetry">) {
    const id = 1492931000000000 + this.cars.length * 7919;
    this.cars.push({ ...car, id, vehicle_id: id + 17, telemetry: null });
  }
  car(vin: string) {
    const found = this.cars.find((car) => car.vin === vin);
    if (!found) throw Error("No mock car " + vin);
    return found;
  }
  mark() {
    return this.log.length;
  }
  since(mark: number) {
    return this.log.slice(mark);
  }
  private record(entry: Omit<LogEntry, "n">) {
    this.log.push({ n: this.log.length + 1, ...entry });
  }

  // Browser side: what Tesla's consent page checks before showing a prompt.
  validateAuthorize(url: string) {
    const u = new URL(url);
    const p = u.searchParams;
    const problems = [
      u.origin + u.pathname !== AUTHORIZE_URL && "wrong authorize endpoint",
      p.get("client_id") !== this.app.client_id && "unknown client_id",
      p.get("redirect_uri") !== this.app.origin + "/auth/callback" &&
        "redirect_uri is not the registered callback",
      p.get("response_type") !== "code" && "response_type must be code",
      !p.get("state") && "missing state",
      !(p.get("scope") ?? "").split(" ").includes("openid") &&
        "missing openid scope",
    ].filter(Boolean) as string[];
    return { problems, scope: (p.get("scope") ?? "").split(" "), params: p };
  }
  // The user signs in as `identity` and approves (optionally unticking scopes).
  // Returns the callback URL Tesla would redirect the browser to.
  consent(
    url: string,
    identity: string,
    { approve = true, without = [] as string[] } = {},
  ) {
    const { problems, scope, params } = this.validateAuthorize(url);
    if (problems.length) throw Error("Tesla would refuse: " + problems);
    if (!this.identities.has(identity)) throw Error("No identity " + identity);
    const back = new URL(params.get("redirect_uri")!);
    back.searchParams.set("state", params.get("state")!);
    if (!approve) back.searchParams.set("error", "access_denied");
    else {
      const code = opaque("NA_");
      this.codes.set(code, {
        identity,
        scope: scope.filter((s) => !without.includes(s)),
        redirect_uri: params.get("redirect_uri")!,
        expires: Date.now() + 600000,
        used: false,
      });
      back.searchParams.set("code", code);
    }
    back.searchParams.set("locale", "en-US");
    back.searchParams.set("issuer", "https://auth.tesla.com/oauth2/v3");
    this.record({
      service: "auth",
      method: "GET",
      path: "/oauth2/v3/authorize (" + (approve ? "approved" : "denied") + ")",
      status: 303,
      identity,
    });
    return back.toString();
  }

  // Tesla-side expiry, e.g. after eight hours: the token no longer works even
  // if teslabot still thinks it does.
  expireAccessTokens(identity: string) {
    for (const grant of this.access.values())
      if (grant.identity === identity) grant.expires = Date.now() - 1;
  }

  private issue({ identity, scope }: Grant) {
    const who = this.identities.get(identity)!;
    const now = Math.floor(Date.now() / 1000);
    const access = jwt({
      iss: "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/nts",
      sub: who.sub,
      aud: [FLEET, "https://fleet-api.prd.eu.vn.cloud.tesla.com"],
      scp: scope,
      azp: this.app.client_id,
      iat: now,
      exp: now + this.accessSeconds,
      ou_code: "NA",
      nonce: randomBytes(8).toString("hex"),
    });
    const refresh = opaque("NA_rt_");
    this.access.set(access, {
      identity,
      scope,
      expires: Date.now() + this.accessSeconds * 1000,
    });
    this.refresh.set(refresh, { identity, scope, used: false });
    this.issued.add(access).add(refresh);
    return Response.json({
      access_token: access,
      refresh_token: refresh,
      id_token: jwt({
        iss: "https://auth.tesla.com/oauth2/v3",
        sub: who.sub,
        aud: this.app.client_id,
        iat: now,
        exp: now + 300,
      }),
      expires_in: this.accessSeconds,
      state: randomBytes(8).toString("hex"),
      token_type: "Bearer",
      scope: scope.join(" "),
    });
  }

  private async token(request: Request) {
    const body = new URLSearchParams(await request.text());
    const fail = (status: number, error: string) =>
      Response.json({ error, error_description: error }, { status });
    if (body.get("client_id") !== this.app.client_id)
      return fail(401, "invalid_client");
    if (body.get("grant_type") === "authorization_code") {
      const code = this.codes.get(body.get("code") ?? "");
      if (body.get("client_secret") !== this.app.client_secret)
        return fail(401, "invalid_client");
      if (!code || code.used || code.expires < Date.now())
        return fail(400, "invalid_grant");
      if (body.get("redirect_uri") !== code.redirect_uri)
        return fail(400, "redirect_uri_mismatch");
      if (body.get("audience") !== FLEET) return fail(400, "invalid_audience");
      code.used = true;
      return this.issue(code);
    }
    if (body.get("grant_type") === "refresh_token") {
      const grant = this.refresh.get(body.get("refresh_token") ?? "");
      // Refresh tokens rotate: each one works once.
      if (!grant || grant.used) return fail(401, "login_required");
      grant.used = true;
      return this.issue(grant);
    }
    return fail(400, "unsupported_grant_type");
  }

  private bearer(request: Request) {
    const token = request.headers.get("Authorization")?.replace(/^Bearer /, "");
    const grant = token ? this.access.get(token) : undefined;
    return grant && grant.expires > Date.now() ? grant : null;
  }
  private listing(car: Car) {
    return {
      id: car.id,
      vehicle_id: car.vehicle_id,
      vin: car.vin,
      color: null,
      access_type: "OWNER",
      display_name: car.display_name,
      option_codes: null,
      granular_access: { hide_private: car.hide_private },
      tokens: null,
      state: car.state,
      in_service: false,
      id_s: String(car.id),
      calendar_enabled: true,
      api_version: 84,
      backseat_token: null,
      backseat_token_updated_at: null,
    };
  }
  // vehicle_data with only the requested endpoints, as Tesla returns it.
  private vehicleData(car: Car, endpoints: string[], location: boolean) {
    const timestamp = Date.now();
    const pressure = (wheel: "fl" | "fr" | "rl" | "rr") => ({
      [`tpms_pressure_${wheel}`]: car.tpms_bar[wheel],
      [`tpms_soft_warning_${wheel}`]: car.tpms_soft[wheel],
      [`tpms_hard_warning_${wheel}`]: car.tpms_hard[wheel],
      [`tpms_last_seen_pressure_time_${wheel}`]:
        Math.floor(timestamp / 1000) - 600,
    });
    const sections: Record<string, unknown> = {};
    if (endpoints.includes("charge_state"))
      sections.charge_state = {
        battery_heater_on: false,
        battery_level: car.battery_level,
        battery_range: car.battery_range,
        charge_current_request: 32,
        charge_enable_request: true,
        charge_energy_added: car.charge_energy_added,
        charge_limit_soc: car.charge_limit_soc,
        charge_limit_soc_max: 100,
        charge_limit_soc_min: 50,
        charge_miles_added_rated: car.charge_energy_added * 4,
        charge_port_door_open: car.charging_state !== "Disconnected",
        charge_port_latch:
          car.charging_state === "Disconnected" ? "Disengaged" : "Engaged",
        charge_rate: car.charge_rate,
        charger_actual_current: car.charger_power ? 48 : 0,
        charger_power: car.charger_power,
        charger_voltage: car.charger_power ? 240 : 0,
        charging_state: car.charging_state,
        conn_charge_cable:
          car.charging_state === "Disconnected" ? "<invalid>" : "SAE",
        est_battery_range: car.battery_range * 0.93,
        fast_charger_present: false,
        ideal_battery_range: car.battery_range,
        minutes_to_full_charge: Math.round(car.time_to_full_charge * 60),
        scheduled_charging_mode: "Off",
        time_to_full_charge: car.time_to_full_charge,
        usable_battery_level: car.usable_battery_level,
        timestamp,
      };
    if (endpoints.includes("climate_state"))
      sections.climate_state = {
        inside_temp: car.inside_temp,
        outside_temp: car.outside_temp,
        is_climate_on: car.is_climate_on,
        is_preconditioning: false,
        driver_temp_setting: 21,
        passenger_temp_setting: 21,
        fan_status: car.is_climate_on ? 4 : 0,
        seat_heater_left: 0,
        defrost_mode: 0,
        cabin_overheat_protection: "On",
        timestamp,
      };
    if (endpoints.includes("vehicle_state"))
      sections.vehicle_state = {
        api_version: 84,
        car_version: car.car_version,
        center_display_state: 0,
        ...car.doors,
        ...car.trunks,
        ...car.windows,
        is_user_present: false,
        locked: car.locked,
        odometer: car.odometer,
        remote_start: false,
        sentry_mode: car.sentry_mode,
        sentry_mode_available: true,
        valet_mode: false,
        vehicle_name: car.display_name,
        ...pressure("fl"),
        ...pressure("fr"),
        ...pressure("rl"),
        ...pressure("rr"),
        timestamp,
      };
    // Since 2023.38 Tesla returns coordinates only for location_data and only
    // with the vehicle_location scope.
    if (
      endpoints.includes("location_data") ||
      endpoints.includes("drive_state")
    )
      sections.drive_state = {
        gps_as_of: Math.floor(timestamp / 1000),
        heading: car.heading,
        power: 0,
        shift_state: null,
        speed: null,
        ...(location && endpoints.includes("location_data")
          ? { latitude: car.latitude, longitude: car.longitude }
          : {}),
        timestamp,
      };
    return { ...this.listing(car), ...sections };
  }

  private async fleet(request: Request, url: URL) {
    const method = request.method;
    const path = url.pathname;
    const grant = this.bearer(request);
    const done = (status: number, body: unknown) => {
      this.record({
        service: "fleet",
        method,
        path: path + (url.search ? decodeURIComponent(url.search) : ""),
        status,
        identity: grant?.identity,
      });
      return Response.json(body, { status });
    };
    if (/wake_up|\/command\//.test(path)) {
      this.violations.push(`${method} ${path} (wake or command)`);
      return done(403, { error: "sandbox: vehicle commands are refused" });
    }
    if (!grant) return done(401, { error: "token expired (401)" });
    if (!grant.scope.includes("vehicle_device_data"))
      return done(403, { error: "missing scope vehicle_device_data" });
    const mine = this.cars.filter((car) => car.owner === grant.identity);
    const find = (vin: string) => mine.find((car) => car.vin === vin);
    if (path === "/api/1/vehicles" && method === "GET")
      return done(200, {
        response: mine.map((car) => this.listing(car)),
        pagination: { previous: null, next: null, current: 1, per_page: 2 },
        count: mine.length,
      });
    if (path === "/api/1/vehicles/fleet_status" && method === "POST") {
      const { vins = [] } = (await request.json()) as { vins?: string[] };
      const owned = vins.map(find).filter(Boolean) as Car[];
      return done(200, {
        response: {
          key_paired_vins: owned.filter((c) => c.key_paired).map((c) => c.vin),
          unpaired_vins: owned.filter((c) => !c.key_paired).map((c) => c.vin),
        },
      });
    }
    const match = path.match(/^\/api\/1\/vehicles\/([A-HJ-NPR-Z0-9]{17})(.*)$/);
    const car = match && find(match[1]);
    if (!car) return done(404, { response: null, error: "not_found" });
    const rest = match![2];
    if (rest === "" && method === "GET")
      return done(200, { response: this.listing(car) });
    if (rest === "/vehicle_data" && method === "GET") {
      if (car.state !== "online")
        return done(408, {
          response: null,
          error: "vehicle unavailable: vehicle is offline or asleep",
        });
      const endpoints = (url.searchParams.get("endpoints") ?? "").split(";");
      return done(200, {
        response: this.vehicleData(
          car,
          endpoints,
          grant.scope.includes("vehicle_location") && !car.hide_private,
        ),
      });
    }
    if (rest === "/fleet_telemetry_config" && method === "GET")
      return done(200, {
        response: {
          synced: car.telemetry?.synced ?? false,
          config: car.telemetry?.config ?? null,
          limit_reached: false,
          key_paired: car.key_paired,
        },
      });
    if (rest === "/fleet_telemetry_config" && method === "DELETE") {
      car.telemetry = null;
      return done(200, { response: { updated_vehicles: 1 } });
    }
    if (rest === "/fleet_telemetry_errors" && method === "GET")
      return done(200, { response: { fleet_telemetry_errors: [] } });
    this.violations.push(`${method} ${path} (unexpected Fleet API call)`);
    return done(404, { response: null, error: "not_found" });
  }

  private async notify(request: Request, url: URL) {
    const json = request.headers.get("Content-Type")?.includes("json");
    const body = await request.text();
    this.inbox.push({
      host: url.host,
      path: url.pathname,
      format: json ? "json" : "ntfy",
      title: json
        ? (JSON.parse(body).title ?? null)
        : request.headers.get("Title"),
      body: json ? JSON.parse(body).message : body,
    });
    this.record({
      service: "notify",
      method: request.method,
      path: url.host + url.pathname,
      status: 200,
    });
    return Response.json({ id: randomBytes(6).toString("hex") });
  }

  // The Worker's outbound fetch: Tesla, notification hosts, nothing else.
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.href === TOKEN_URL && request.method === "POST") {
      const response = await this.token(request);
      this.record({
        service: "auth",
        method: "POST",
        path: "/oauth2/v3/token",
        status: response.status,
      });
      return response;
    }
    if (url.origin === FLEET) return this.fleet(request, url);
    if (NOTIFY_HOSTS.includes(url.host) && request.method === "POST")
      return this.notify(request, url);
    this.violations.push(`${request.method} ${url.origin} (unknown host)`);
    this.record({
      service: "blocked",
      method: request.method,
      path: url.origin + url.pathname,
      status: 502,
    });
    return new Response("sandbox: no network access", { status: 502 });
  }

  // The telemetry Worker's /configure, which signs the configuration with the
  // partner key and asks Tesla to push it to the car.
  async signer(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const reply = (status: number, body: unknown) => {
      this.record({
        service: "signer",
        method: request.method,
        path: url.pathname,
        status,
      });
      return Response.json(body, { status });
    };
    if (
      request.headers.get("Authorization") !==
      "Bearer " + this.app.relay_token
    )
      return reply(401, { error: { code: "unauthorized" } });
    if (url.pathname !== "/configure" || request.method !== "POST")
      return reply(404, { error: { code: "not_found" } });
    const tesla = request.headers
      .get("X-Tesla-Authorization")
      ?.replace(/^Bearer /, "");
    const grant = tesla ? this.access.get(tesla) : undefined;
    if (!grant || grant.expires <= Date.now())
      return reply(401, { error: "token expired (401)" });
    const { vins, config } = (await request.json()) as {
      vins: string[];
      config: unknown;
    };
    const skipped: Record<string, string[]> = {
      missing_key: [],
      unsupported_hardware: [],
      unsupported_firmware: [],
      max_configs: [],
    };
    let updated = 0;
    for (const vin of vins) {
      const car = this.cars.find(
        (c) => c.vin === vin && c.owner === grant.identity,
      );
      if (!car) continue;
      if (!car.key_paired) skipped.missing_key.push(vin);
      else {
        car.telemetry = { config, synced: false };
        updated++;
      }
    }
    return reply(200, {
      response: { updated_vehicles: updated, skipped_vehicles: skipped },
    });
  }
}
