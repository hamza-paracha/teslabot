import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../../mcp/src/server";
import { normalize } from "../../src/tesla/normalization";
import { createHarness, SYNTHETIC_VEHICLE_ID, type Harness } from "./harness";

// The round-trip question, asked through the real MCP tool, Worker routes,
// vehicle cache and trip planner against a synthetic car.
export const trip = {
  origin: "Home",
  destination: "Office",
  route_source: "fixed sample distances (no routing service called)",
  legs: [{ to: "Office", distance_km: 92 }],
  return_distance_km: 92,
  reserve_percentage: 20,
};
export const HOURS_ASLEEP = 3;
export const scenarios = {
  fresh:
    "The car is online. The first question reads it; the follow-up is served from the cache.",
  asleep: `The car fell asleep ${HOURS_ASLEEP} hours ago and the cache holds its last reading from then. teslabot never wakes the car.`,
} as const;
export type Scenario = keyof typeof scenarios;

export interface Step {
  question: string;
  arguments: Record<string, unknown>;
  latency_ms: number;
  upstream: {
    total: number;
    vehicle_data: number;
    wake_or_command: number;
    calls: string[];
  };
  plan: Record<string, any>;
}

async function connect(h: Harness) {
  const server = createServer(h.e.APP_ORIGIN, h.e.MCP_TOKEN!, (input, init) =>
    h.request(new URL(String(input)).pathname, init),
  );
  const client = new Client({ name: "teslabot-demo", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  return client;
}

async function ask(
  h: Harness,
  client: Client,
  question: string,
  args: Record<string, unknown>,
): Promise<Step> {
  h.tesla.reset();
  const started = performance.now();
  const result = await client.callTool({
    name: "tesla_plan_trip",
    arguments: args,
  });
  return {
    question,
    arguments: args,
    latency_ms: Math.round(performance.now() - started),
    upstream: {
      total: h.tesla.count(),
      vehicle_data: h.tesla.count("vehicle_data"),
      wake_or_command: h.tesla.count("wake"),
      calls: [...h.tesla.calls],
    },
    plan: result.structuredContent as Record<string, any>,
  };
}

// Store the reading the car reported before it slept, as the last successful
// refresh would have left it.
async function fallAsleep(h: Harness) {
  const then = Date.now() - HOURS_ASLEEP * 3600000;
  const { car } = h.tesla;
  const reading = normalize(
    {
      charge_state: {
        battery_level: car.battery_level,
        battery_range: car.battery_range_miles,
        charging_state: car.charging_state,
        charge_limit_soc: car.charge_limit_soc,
        timestamp: then,
      },
      climate_state: { inside_temp: 19, outside_temp: 3, timestamp: then },
      vehicle_state: { locked: true, odometer: 18000, timestamp: then },
    },
    SYNTHETIC_VEHICLE_ID,
    "Synthetic Model 3",
    false,
  );
  reading.data.retrieved_at = new Date(then).toISOString();
  await h.store.put("summary", reading);
  car.state = "asleep";
}

// Each scenario gets its own database, account and synthetic car.
export async function runScenario(
  scenario: Scenario,
  onStep: (step: Step) => void = () => {},
) {
  const h = await createHarness();
  try {
    if (scenario === "asleep") await fallAsleep(h);
    const client = await connect(h);
    const steps: Step[] = [];
    const record = (step: Step) => (steps.push(step), onStep(step), step);
    const first = record(
      await ask(h, client, "Can I make the round trip?", trip),
    );
    record(
      await ask(h, client, "What if I want 30% left when I get home?", {
        trip_id: first.plan.trip_id,
        reserve_percentage: 30,
      }),
    );
    await client.close();
    return steps;
  } finally {
    await h.close();
  }
}
