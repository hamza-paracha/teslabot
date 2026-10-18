import { z } from "zod";
import { freshness, type Observation } from "./observations";
export const chargingPlanSchema = z
  .object({
    target_percentage: z.number().min(1).max(100),
    usable_capacity_kwh: z.number().positive().max(250),
    charger_power_kw: z.number().positive().max(500).optional(),
    electricity_price_per_kwh: z.number().nonnegative().max(100).optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .default("CAD"),
    charging_efficiency: z.number().min(0.5).max(1).default(0.9),
  })
  .strict();
export function planCharging(
  current: Observation,
  input: z.infer<typeof chargingPlanSchema>,
) {
  const observed = freshness(
    current.data.sections?.charging?.observed_at ?? null,
  );
  const start = current.battery.percentage;
  const usable = !current.data.is_stale && !observed.is_stale && start !== null;
  const energy = usable
    ? (Math.max(0, input.target_percentage - start) / 100) *
      input.usable_capacity_kwh
    : null;
  const grid = energy === null ? null : energy / input.charging_efficiency;
  const power =
    input.charger_power_kw ??
    (current.charging.power_kw && current.charging.power_kw > 0
      ? current.charging.power_kw
      : null);
  const hours = grid !== null && power ? grid / power : null;
  const round = (value: number | null, places = 2) =>
    value === null ? null : Math.round(value * 10 ** places) / 10 ** places;
  return {
    vehicle: { id: current.vehicle.id },
    assessment: !usable
      ? "insufficient_fresh_data"
      : energy === 0
        ? "target_already_met"
        : "estimate_available",
    current_percentage: usable ? start : null,
    target_percentage: input.target_percentage,
    estimated_battery_energy_kwh: round(energy),
    estimated_grid_energy_kwh: round(grid),
    estimated_duration_hours: round(hours),
    estimated_cost:
      grid !== null && input.electricity_price_per_kwh !== undefined
        ? round(grid * input.electricity_price_per_kwh)
        : null,
    currency:
      input.electricity_price_per_kwh !== undefined ? input.currency : null,
    assumptions: {
      usable_capacity_kwh: input.usable_capacity_kwh,
      capacity_source: "supplied_by_caller",
      charger_power_kw: power,
      power_source:
        input.charger_power_kw !== undefined
          ? "supplied_by_caller"
          : power
            ? "observed_charger_power"
            : "unknown",
      electricity_price_per_kwh: input.electricity_price_per_kwh ?? null,
      charging_efficiency: input.charging_efficiency,
    },
    limitations: [
      "Planning only: this does not change charge limit or start charging.",
      "Capacity and tariff are supplied by the caller; no battery health or historical electricity costs are inferred.",
      "Duration assumes constant grid input power and efficiency. Tapering, temperature, preconditioning and shared power can extend it.",
      "Cost excludes any taxes, session fees and idle fees not included in the supplied tariff.",
    ],
    data: { ...current.data, ...observed, is_stale: !usable },
  };
}
