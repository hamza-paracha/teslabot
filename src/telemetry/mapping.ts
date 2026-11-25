import { freshness, type Observation } from "../context/observations";
import { normalize } from "../tesla/normalization";

// Signals requested from the car. Values arrive only when they change, at most
// once per interval; Tesla bills per signal received.
export const TELEMETRY_FIELDS: Record<string, { interval_seconds: number }> = {
  BatteryLevel: { interval_seconds: 60 },
  RatedRange: { interval_seconds: 60 },
  EstBatteryRange: { interval_seconds: 300 },
  ChargeLimitSoc: { interval_seconds: 300 },
  DetailedChargeState: { interval_seconds: 60 },
  ACChargingPower: { interval_seconds: 60 },
  DCChargingPower: { interval_seconds: 60 },
  TimeToFullCharge: { interval_seconds: 300 },
  ChargeRateMilePerHour: { interval_seconds: 300 },
  Locked: { interval_seconds: 60 },
  DoorState: { interval_seconds: 60 },
  FdWindow: { interval_seconds: 60 },
  FpWindow: { interval_seconds: 60 },
  RdWindow: { interval_seconds: 60 },
  RpWindow: { interval_seconds: 60 },
  SentryMode: { interval_seconds: 300 },
  InsideTemp: { interval_seconds: 300 },
  OutsideTemp: { interval_seconds: 300 },
  Odometer: { interval_seconds: 600 },
  Version: { interval_seconds: 3600 },
  VehicleName: { interval_seconds: 3600 },
  TpmsPressureFl: { interval_seconds: 600 },
  TpmsPressureFr: { interval_seconds: 600 },
  TpmsPressureRl: { interval_seconds: 600 },
  TpmsPressureRr: { interval_seconds: 600 },
  TpmsSoftWarnings: { interval_seconds: 600 },
  TpmsHardWarnings: { interval_seconds: 600 },
};
export const LOCATION_FIELDS = { Location: { interval_seconds: 300 } };

type Value = Record<string, unknown> | null | undefined;
const MILES = 1.609344;

// fleet-telemetry emits protojson. Fields are typed when prefer_typed is set,
// but older firmware sends strings, so both forms are accepted.
function scalar(value: Value): unknown {
  if (!value || typeof value !== "object" || value.invalid) return null;
  for (const key of ["doubleValue", "floatValue", "intValue", "longValue"])
    if (key in value) return Number(value[key]);
  if ("booleanValue" in value) return value.booleanValue === true;
  if ("stringValue" in value) return value.stringValue;
  const typed = Object.entries(value).find(([key]) => key.endsWith("Value"));
  return typed ? typed[1] : null;
}
const num = (value: Value) => {
  const raw = scalar(value);
  const parsed =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim() !== ""
        ? Number(raw)
        : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};
const bool = (value: Value) => {
  const raw = scalar(value);
  return typeof raw === "boolean"
    ? raw
    : raw === "true"
      ? true
      : raw === "false"
        ? false
        : null;
};
const text = (value: Value) => {
  const raw = scalar(value);
  return typeof raw === "string" && raw ? raw.slice(0, 200) : null;
};
const windowOpen = (value: Value) => {
  const raw = String(scalar(value) ?? "");
  return /Closed/i.test(raw) ? false : /Open/i.test(raw) ? true : null;
};
const tireFlags = (value: Value) => {
  const raw = value?.tireLocationValue as Record<string, boolean> | undefined;
  return raw && typeof raw === "object"
    ? {
        front_left: raw.frontLeft === true,
        front_right: raw.frontRight === true,
        rear_left: raw.rearLeft === true,
        rear_right: raw.rearRight === true,
      }
    : null;
};

export interface TelemetryPayload {
  vin?: string;
  createdAt?: string;
  data?: Array<{ key?: string; value?: Value }>;
}

// Source time of a record, or null when it is missing or implausibly far in
// the future. Arrival time is not a substitute: a retried record would look new.
export function recordTime(payload: { createdAt?: unknown }, now = Date.now()) {
  const created = Date.parse(String(payload.createdAt ?? ""));
  return Number.isFinite(created) && created <= now + 60000
    ? new Date(created).toISOString()
    : null;
}

// Signals that write the same stored value share one clock, so an older
// fallback (estimated range) cannot replace a newer primary value.
const STORED_AS: Record<string, string> = {
  RatedRange: "range_km",
  EstBatteryRange: "range_km",
};

// What the stored observation already reflects, so records that arrive late or
// twice cannot overwrite newer values: the source time of each stored value
// last applied (null when its record was undated), the section times of the
// Fleet API read the patches build on, and the latest connectivity event.
export interface SignalClock {
  signals: Record<string, string | null>;
  baseline: Record<string, string | null>;
  connectivity: { at: string | null; connected: boolean } | null;
  power?: { ac?: number; dc?: number };
}
export const emptyClock = (): SignalClock => ({
  signals: {},
  baseline: {},
  connectivity: null,
});

export function telemetryOnline(
  clock: SignalClock,
  current?: Observation,
): boolean {
  const event = clock.connectivity;
  if (!event || event.connected) return true;
  const times =
    current?.data.source === "tesla_fleet_api"
      ? Object.values(current.data.sections ?? {}).map(
          (section) => section.observed_at,
        )
      : [...Object.values(clock.signals), ...Object.values(clock.baseline)];
  return times.some(
    (at) => at !== null && (event.at === null || at > event.at),
  );
}

// Patch the stored observation with one telemetry record. A value is applied
// only if the record is newer than the one that last set that value (and than
// the Fleet API read underneath); otherwise the observation is returned
// unchanged. An undated record can only fill a value nothing has set yet, and
// does not make its section fresh. Each section keeps the time of its newest value; the observation
// as a whole is only as fresh as its oldest section, so stale sections still
// fall back to a normal Fleet API read.
export function applyTelemetry(
  current: Observation | null,
  payload: TelemetryPayload,
  vehicleId: string,
  location: boolean,
  now = Date.now(),
  clock: SignalClock = emptyClock(),
): Observation {
  const dated = recordTime(payload, now);
  const at = dated ?? new Date(now).toISOString();
  const same = current?.vehicle.id === vehicleId;
  if (!same || current.data.source !== "tesla_fleet_telemetry") {
    // A new car, or a fresh Fleet API read since the last record: values now
    // date from that read.
    clock.signals = {};
    delete clock.power;
    clock.baseline = same
      ? Object.fromEntries(
          Object.entries(current.data.sections ?? {}).map(([name, section]) => [
            name,
            section.observed_at,
          ]),
        )
      : {};
  }
  const base: Observation = structuredClone(
    same
      ? current
      : normalize(
          { charge_state: {}, climate_state: {}, vehicle_state: {} },
          vehicleId,
          null,
          location,
        ),
  );
  const time = dated === null ? null : Date.parse(dated);
  const touched = new Set<string>();
  const before = { ...clock.signals };
  const hadPower = ["ACChargingPower", "DCChargingPower", "power_kw"].some(
    (signal) => signal in before,
  );
  let powerUpdated = false;
  let key = "";
  const set = (section: string, apply: () => void) => {
    const isPower = key === "ACChargingPower" || key === "DCChargingPower";
    // Older snapshots only kept a shared power timestamp.
    const priorKey = isPower && !(key in before) ? "power_kw" : key;
    const last = [before[priorKey], clock.baseline[section]].filter(
      (value): value is string => !!value,
    );
    if (
      time === null
        ? priorKey in before || last.length || (isPower && hadPower)
        : last.some((value) => Date.parse(value) >= time)
    )
      return;
    apply();
    clock.signals[key] = dated;
    touched.add(section);
  };
  for (const datum of payload.data ?? []) {
    key = STORED_AS[datum.key ?? ""] ?? datum.key ?? "";
    const v = datum.value;
    // "invalid" means the signal is temporarily unavailable: keep the last
    // known value and its timestamp rather than recording an unknown as new.
    if (!v || typeof v !== "object" || v.invalid === true) continue;
    switch (datum.key) {
      case "BatteryLevel": {
        const level = num(v);
        if (level !== null && level >= 0 && level <= 100)
          set("battery", () => (base.battery.percentage = Math.round(level)));
        break;
      }
      case "RatedRange":
      case "EstBatteryRange": {
        const miles = num(v);
        // Rated range matches vehicle_data's battery_range; estimated is a fallback.
        if (
          miles !== null &&
          miles >= 0 &&
          (datum.key === "RatedRange" ||
            !(payload.data ?? []).some((d) => d.key === "RatedRange"))
        )
          set("battery", () => (base.battery.range_km = miles * MILES));
        break;
      }
      case "ChargeLimitSoc":
        set("charging", () => (base.charging.limit_percentage = num(v)));
        break;
      case "DetailedChargeState": {
        const state = text(v)?.replace(/^DetailedChargeState/, "") ?? null;
        if (state)
          set("charging", () => {
            base.charging.state = state;
            base.charging.charging = state === "Charging";
            base.charging.connected =
              state === "Unknown" ? null : state !== "Disconnected";
          });
        break;
      }
      case "ACChargingPower":
      case "DCChargingPower": {
        const kw = num(v);
        if (kw !== null) {
          const source = datum.key === "ACChargingPower" ? "ac" : "dc";
          set("charging", () => {
            (clock.power ??= {})[source] = Math.max(0, kw);
            powerUpdated = true;
          });
        }
        break;
      }
      case "TimeToFullCharge":
        set("charging", () => (base.charging.hours_remaining = num(v)));
        break;
      case "ChargeRateMilePerHour": {
        const rate = num(v);
        set(
          "charging",
          () =>
            (base.charging.range_added_km_per_hour =
              rate === null || rate < 0 ? null : rate * MILES),
        );
        break;
      }
      case "Locked":
        set("vehicle", () => (base.vehicle.locked = bool(v)));
        break;
      case "SentryMode": {
        const mode = text(v);
        set(
          "vehicle",
          () =>
            (base.vehicle.sentry_mode =
              !mode || /Unknown/.test(mode) ? null : !/Off$/.test(mode)),
        );
        break;
      }
      case "Odometer": {
        const miles = num(v);
        set(
          "vehicle",
          () =>
            (base.vehicle.odometer_km = miles === null ? null : miles * MILES),
        );
        break;
      }
      case "Version":
        set("vehicle", () => (base.vehicle.software_version = text(v)));
        break;
      case "VehicleName":
        set("vehicle", () => (base.vehicle.display_name = text(v)));
        break;
      case "DoorState": {
        const doors = v?.doorValue as Record<string, boolean> | undefined;
        if (doors && typeof doors === "object")
          set("vehicle", () => {
            base.closures.doors = {
              driver_front: doors.DriverFront === true,
              driver_rear: doors.DriverRear === true,
              passenger_front: doors.PassengerFront === true,
              passenger_rear: doors.PassengerRear === true,
            };
            base.closures.front_trunk_open = doors.TrunkFront === true;
            base.closures.rear_trunk_open = doors.TrunkRear === true;
          });
        break;
      }
      case "FdWindow":
      case "FpWindow":
      case "RdWindow":
      case "RpWindow": {
        const position = {
          FdWindow: "driver_front",
          FpWindow: "passenger_front",
          RdWindow: "driver_rear",
          RpWindow: "passenger_rear",
        }[datum.key] as keyof Observation["closures"]["windows"];
        set("vehicle", () => (base.closures.windows[position] = windowOpen(v)));
        break;
      }
      case "TpmsPressureFl":
      case "TpmsPressureFr":
      case "TpmsPressureRl":
      case "TpmsPressureRr": {
        const wheel = {
          TpmsPressureFl: "front_left",
          TpmsPressureFr: "front_right",
          TpmsPressureRl: "rear_left",
          TpmsPressureRr: "rear_right",
        }[datum.key] as keyof Observation["tires"];
        const bar = num(v);
        set("vehicle", () => {
          base.tires[wheel].pressure_bar = bar !== null && bar > 0 ? bar : null;
          base.tires[wheel].pressure_psi =
            bar !== null && bar > 0
              ? Math.round(bar * 14.5037738 * 10) / 10
              : null;
        });
        break;
      }
      case "TpmsSoftWarnings":
      case "TpmsHardWarnings": {
        const flags = tireFlags(v);
        const field =
          datum.key === "TpmsSoftWarnings" ? "soft_warning" : "hard_warning";
        if (flags)
          set("vehicle", () => {
            for (const wheel of Object.keys(flags) as Array<keyof typeof flags>)
              base.tires[wheel][field] = flags[wheel];
          });
        break;
      }
      case "InsideTemp":
        set("climate", () => (base.climate.interior_c = num(v)));
        break;
      case "OutsideTemp":
        set("climate", () => (base.climate.exterior_c = num(v)));
        break;
      case "Location": {
        const point = v?.locationValue as
          { latitude?: number; longitude?: number } | undefined;
        if (location && point && typeof point === "object")
          set("location", () => {
            base.location = {
              latitude: point.latitude ?? null,
              longitude: point.longitude ?? null,
              observed_at: dated,
            };
          });
        break;
      }
    }
  }
  if (powerUpdated) {
    const acDated = clock.signals.ACChargingPower != null;
    const dcDated = clock.signals.DCChargingPower != null;
    const ac = dcDated && !acDated ? undefined : clock.power!.ac;
    const dc = acDated && !dcDated ? undefined : clock.power!.dc;
    base.charging.power_kw =
      dc !== undefined && dc > 0 ? dc : (ac ?? dc ?? null);
  }
  const sections = { ...base.data.sections } as Record<
    string,
    ReturnType<typeof freshness>
  >;
  if (!touched.size && same) return current;
  base.vehicle.online = telemetryOnline(clock);
  if (!touched.size) return base;
  for (const section of touched)
    if (time !== null && (section !== "location" || location)) {
      const previous = Date.parse(sections[section]?.observed_at ?? "");
      sections[section] = freshness(
        previous > time ? sections[section].observed_at : at,
        now,
      );
    }
  const times = Object.values(sections)
    .map((section) => section.observed_at)
    .filter((value): value is string => !!value);
  const oldest = times.length
    ? new Date(Math.min(...times.map((t) => Date.parse(t)))).toISOString()
    : null;
  const fresh = freshness(oldest, now);
  base.data = {
    ...base.data,
    sections: sections as Observation["data"]["sections"],
    observed_at: oldest,
    // A patched snapshot is only as current as its oldest section.
    retrieved_at: oldest ?? new Date(now).toISOString(),
    is_stale: fresh.is_stale,
    source: "tesla_fleet_telemetry",
    cache_hit: false,
    already_awake: null,
    may_incur_api_charges: false,
  };
  return base;
}
