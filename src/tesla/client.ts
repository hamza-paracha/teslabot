import { platformFetch } from "./fetch";
import { z } from "zod";
import { AppError, type Env } from "../types";
import { Store } from "../storage/database";
import { ownerToken, regions, type Tokens } from "./auth";
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
  // Check this account's daily requests and the installation's monthly estimated
  // spend, and record the reservation, in one atomic statement.
  async reserve(category: "data" | "metadata", cost: number) {
    const e = this.store.env,
      account = this.store.account,
      date = new Date().toISOString(),
      day = date.slice(0, 10),
      month = date.slice(0, 7);
    const row = await e.DB.prepare(
      "INSERT INTO usage(account,month,day,category,count,estimated_usd) SELECT ?,?,?,?,1,? WHERE (SELECT COALESCE(SUM(count),0) FROM usage WHERE account=? AND day=?) < ? AND (SELECT COALESCE(SUM(estimated_usd),0) FROM usage WHERE month=?) + ? <= ? ON CONFLICT(account,day,category) DO UPDATE SET count=count+1,estimated_usd=estimated_usd+excluded.estimated_usd RETURNING count",
    )
      .bind(
        account,
        month,
        day,
        category,
        cost,
        account,
        day,
        Number(e.MAX_REQUESTS_PER_DAY),
        month,
        cost,
        Number(e.MAX_ESTIMATED_MONTHLY_SPEND_USD),
      )
      .first();
    if (!row) throw new AppError("local_usage_limit", 429);
  }
  private token?: Promise<Tokens>;
  // One request can make several Tesla calls; read and decrypt the token once.
  ownerToken() {
    this.token ??= ownerToken(this.store).catch((error) => {
      this.token = undefined;
      throw error;
    });
    return this.token;
  }
  get(path: string, category: "data" | "metadata" = "metadata") {
    return this.request("GET", path, category);
  }
  // Read-only access plus the two telemetry management calls; vehicle commands
  // and wakes are never sent from here.
  async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    category: "data" | "metadata" = "metadata",
    body?: unknown,
  ): Promise<unknown> {
    if (!/^\/api\/1\/vehicles(?:$|[/?])/.test(path) || path.includes(".."))
      throw new AppError("invalid_api_path");
    if (
      (method === "POST" && path !== "/api/1/vehicles/fleet_status") ||
      (method === "DELETE" &&
        !/^\/api\/1\/vehicles\/[A-HJ-NPR-Z0-9]{17}\/fleet_telemetry_config$/.test(
          path,
        ))
    )
      throw new AppError("invalid_api_path");
    const t = await this.ownerToken();
    if (
      t.scope !== undefined &&
      !t.scope.split(/\s+/).includes("vehicle_device_data")
    )
      throw new AppError("missing_vehicle_data_scope", 403);
    await this.reserve(category, category === "data" ? 0.002 : 0);
    let r: Response;
    try {
      r = await this.fetcher(regions[this.store.env.TESLA_REGION] + path, {
        method,
        headers: {
          Authorization: "Bearer " + t.access_token,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
    let result: any;
    try {
      result = await r.json();
    } catch {
      throw new AppError("unexpected_tesla_response", 502);
    }
    if (!result || !("response" in result) || result.error)
      throw new AppError("unexpected_tesla_response", 502);
    return result.response;
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
