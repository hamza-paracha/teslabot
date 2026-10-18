export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_ORIGIN: string;
  TESLA_CLIENT_ID?: string;
  TESLA_CLIENT_SECRET?: string;
  TOKEN_ENCRYPTION_KEY?: string;
  ADMIN_TOKEN?: string;
  MCP_TOKEN?: string;
  TESLA_REGION: "na" | "eu";
  ENABLE_LOCATION: string;
  ENABLE_VEHICLE_COMMANDS: string;
  ALLOW_VEHICLE_WAKE: string;
  MAX_REQUESTS_PER_DAY: string;
  MAX_ESTIMATED_MONTHLY_SPEND_USD: string;
  CACHE_TTL_SECONDS: string;
}
export class AppError extends Error {
  constructor(
    public code: string,
    public status = 400,
    public retryAfter?: string,
  ) {
    super(code);
  }
}
