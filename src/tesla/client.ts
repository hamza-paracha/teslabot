import { platformFetch } from "./fetch";
import { z } from "zod";
import { AppError, type Env } from "../types";
import { Store } from "../storage/database";
import { ownerToken, regions } from "./auth";
export const vehicleSchema = z.object({
  vin: z.string().regex(/^[A-HJ-NPR-Z0-9]{17}$/),
  display_name: z.string().nullable().optional(),
  state: z.string(),
  granular_access: z
    .object({ hide_private: z.boolean().optional() })
    .optional(),
});
export type Vehicle = z.infer<typeof vehicleSchema>;
export class TeslaClient {
  constructor(
    public store: Store,
    public fetcher: typeof fetch = platformFetch,
  ) {}
  async reserve(category: "data" | "metadata", cost: number) {
    const e = this.store.env,
      date = new Date().toISOString(),
      day = date.slice(0, 10),
      month = date.slice(0, 7);
    await this.store.locked("budget", async () => {
      const dayTotal = await e.DB.prepare(
        "SELECT COALESCE(SUM(count),0) AS count FROM usage WHERE day=?",
      )
        .bind(day)
        .first<{ count: number }>();
      const spent = await e.DB.prepare(
        "SELECT COALESCE(SUM(estimated_usd),0) AS cost FROM usage WHERE month=?",
      )
        .bind(month)
        .first<{ cost: number }>();
      if (
        (dayTotal?.count ?? 0) >= Number(e.MAX_REQUESTS_PER_DAY) ||
        (spent?.cost ?? 0) + cost > Number(e.MAX_ESTIMATED_MONTHLY_SPEND_USD)
      )
        throw new AppError("local_usage_limit", 429);
      await e.DB.prepare(
        "INSERT INTO usage(month,day,category,count,estimated_usd) VALUES(?,?,?,1,?) ON CONFLICT(day,category) DO UPDATE SET count=count+1,estimated_usd=estimated_usd+excluded.estimated_usd",
      )
        .bind(month, day, category, cost)
        .run();
    });
  }
  async get(
    path: string,
    category: "data" | "metadata" = "metadata",
  ): Promise<unknown> {
    if (!/^\/api\/1\/vehicles(?:$|[/?])/.test(path) || path.includes(".."))
      throw new AppError("invalid_api_path");
    const t = await ownerToken(this.store);
    await this.reserve(category, category === "data" ? 0.002 : 0);
    let r: Response;
    try {
      r = await this.fetcher(regions[this.store.env.TESLA_REGION] + path, {
        headers: {
          Authorization: "Bearer " + t.access_token,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      });
    } catch {
      throw new AppError("tesla_timeout", 504);
    }
    if (!r.ok) {
      const codes: Record<number, string> = {
        401: "reauthorization_required",
        403: "permission_denied",
        404: "vehicle_not_found",
        408: "vehicle_unavailable",
        412: "partner_registration_required",
        421: "wrong_region",
        422: "unsupported",
        429: "tesla_rate_limited",
      };
      throw new AppError(
        codes[r.status] ?? "tesla_server_error",
        r.status >= 500 ? 502 : r.status,
        r.headers.get("Retry-After") ?? undefined,
      );
    }
    let body: any;
    try {
      body = await r.json();
    } catch {
      throw new AppError("unexpected_tesla_response", 502);
    }
    if (!body || !("response" in body) || body.error)
      throw new AppError("unexpected_tesla_response", 502);
    return body.response;
  }
  async vehicles(): Promise<Vehicle[]> {
    const result = await this.get("/api/1/vehicles");
    const parsed = z.array(vehicleSchema).safeParse(result);
    if (!parsed.success) throw new AppError("unexpected_tesla_response", 502);
    return parsed.data;
  }
  async vehicle(vin: string): Promise<Vehicle> {
    if (!vehicleSchema.shape.vin.safeParse(vin).success)
      throw new AppError("invalid_vehicle_identifier");
    const p = vehicleSchema.safeParse(await this.get("/api/1/vehicles/" + vin));
    if (!p.success) throw new AppError("unexpected_tesla_response", 502);
    return p.data;
  }
}
