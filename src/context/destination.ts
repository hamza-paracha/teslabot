import { z } from "zod";
import { estimateTrip, type Observation } from "./observations";
export const destinationSchema = z
  .object({
    destination: z.string().min(1).max(300),
    origin: z.string().min(1).max(300).optional(),
    route: z
      .object({
        source: z.string().min(1).max(120),
        one_way_distance_km: z.number().min(0).max(2500),
        return_distance_km: z.number().min(0).max(2500).optional(),
      })
      .strict()
      .optional(),
    reserve_percentage: z.number().min(5).max(50).default(20),
  })
  .strict();
export function assessDestination(
  input: z.infer<typeof destinationSchema>,
  observation: Observation | null,
) {
  const base = {
    destination: input.destination,
    origin: input.origin ?? null,
    reserve_percentage: input.reserve_percentage,
    route_source: input.route?.source ?? null,
    one_way: null as ReturnType<typeof estimateTrip> | null,
    round_trip: null as ReturnType<typeof estimateTrip> | null,
    return_distance_assumed: false,
    assumptions: [] as string[],
    missing_context: [] as string[],
    actions_executed: false,
  };
  if (!input.origin || !input.route)
    return {
      ...base,
      assessment: "route_required",
      missing_context: [
        "Use the host's authorized routing tool to resolve the destination and route from a confirmed origin. A place name alone is not a driving distance.",
      ],
    };
  if (!observation)
    return {
      ...base,
      assessment: "vehicle_data_required",
      missing_context: [
        "A fresh authorized battery reading is required to estimate arrival percentages.",
      ],
    };
  const returnDistance =
    input.route.return_distance_km ?? input.route.one_way_distance_km;
  const oneWay = estimateTrip(observation, {
    distance_km: input.route.one_way_distance_km,
    reserve_percentage: input.reserve_percentage,
  });
  const roundTrip = estimateTrip(observation, {
    distance_km: input.route.one_way_distance_km + returnDistance,
    reserve_percentage: input.reserve_percentage,
  });
  return {
    ...base,
    assessment: roundTrip.assessment,
    one_way: oneWay,
    round_trip: roundTrip,
    return_distance_assumed: input.route.return_distance_km === undefined,
    assumptions: [
      ...(input.route.return_distance_km === undefined
        ? [
            "Return distance is assumed equal to outbound distance; an actual return route may differ.",
          ]
        : []),
      "Both estimates start from the same current battery reading and assume no charging between legs.",
      "These are range-based estimates, not guarantees; weather, speed, elevation and cabin heating can change consumption.",
    ],
  };
}
