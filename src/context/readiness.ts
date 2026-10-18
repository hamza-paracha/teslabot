import { refreshObservation, type Observation } from "./observations";
export function readiness(observation: Observation) {
  const current = refreshObservation(observation);
  const items: Array<{
    code: string;
    state: "attention" | "ok" | "unknown";
    observed_value: boolean | null;
  }> = [];
  const check = (
    code: string,
    value: boolean | null | undefined,
    attentionWhen = true,
  ) =>
    items.push({
      code,
      state:
        value == null
          ? "unknown"
          : value === attentionWhen
            ? "attention"
            : "ok",
      observed_value: value ?? null,
    });
  check("vehicle_unlocked", current.vehicle.locked, false);
  for (const group of ["doors", "windows"] as const)
    for (const position of [
      "driver_front",
      "driver_rear",
      "passenger_front",
      "passenger_rear",
    ] as const)
      check(`${group}_${position}_open`, current.closures?.[group]?.[position]);
  check("front_trunk_open", current.closures?.front_trunk_open);
  check("rear_trunk_open", current.closures?.rear_trunk_open);
  for (const wheel of [
    "front_left",
    "front_right",
    "rear_left",
    "rear_right",
  ] as const) {
    check(`tire_${wheel}_soft_warning`, current.tires?.[wheel]?.soft_warning);
    check(`tire_${wheel}_hard_warning`, current.tires?.[wheel]?.hard_warning);
  }
  const attention = items.filter((item) => item.state === "attention");
  const unknown = items.filter((item) => item.state === "unknown");
  return {
    vehicle: current.vehicle,
    assessment: current.data.is_stale
      ? "stale_observation"
      : attention.length
        ? "attention_needed"
        : unknown.length
          ? "partial_data"
          : "no_reported_issues",
    attention,
    unavailable_checks: unknown.map((item) => item.code),
    checks: items,
    tires: current.tires ?? null,
    limitations: [
      "This is a report of observed sensor flags, not a vehicle inspection or assurance that it is safe to drive.",
      "Individual tire measurements may be older than the vehicle-state timestamp. Use the vehicle's recommended tire pressures; no arbitrary low-pressure threshold was applied.",
      "Missing sensor values are unknown, never assumed closed or normal.",
    ],
    data: current.data,
  };
}
