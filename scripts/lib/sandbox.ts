import {
  Miniflare,
  convertV4MiniflareOptions,
  Response as MiniflareResponse,
  type Request as MiniflareRequest,
} from "miniflare";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Store } from "../../src/storage/database";
import { KEY_PATH } from "../../src/tesla/partner";
import type { Env } from "../../src/types";
import { MockTesla } from "./mock-tesla";

// The deployed Worker bundle, running in workerd through Miniflare with a local
// D1 database. Its outbound fetches, the ASSETS binding and the TELEMETRY
// service binding are all answered in-process by MockTesla.

const root = new URL("../../", import.meta.url).pathname;
export const ORIGIN = "https://localhost:8787";
type Handler = (request: Request) => Promise<Response> | Response;

// Miniflare hands Node handlers its own undici classes; convert at the edge.
const adapt =
  (handler: Handler) =>
  async (request: MiniflareRequest): Promise<MiniflareResponse> => {
    const body = ["GET", "HEAD"].includes(request.method)
      ? undefined
      : await request.arrayBuffer();
    const response = await handler(
      new Request(request.url, {
        method: request.method,
        headers: [...request.headers],
        body,
      }),
    );
    return new MiniflareResponse(
      response.body ? await response.arrayBuffer() : null,
      { status: response.status, headers: [...response.headers] },
    );
  };

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".pem": "application/x-pem-file",
};
// Static assets as Cloudflare would serve them from public/.
function assets(publicKey: string): Handler {
  return (request) => {
    const path = new URL(request.url).pathname;
    if (path === KEY_PATH) return new Response(publicKey);
    const file = join(root, "public", path === "/" ? "index.html" : path);
    if (!file.startsWith(join(root, "public")) || !existsSync(file))
      return new Response("Not found", { status: 404 });
    return new Response(readFileSync(file), {
      headers: { "Content-Type": types[extname(file)] ?? "text/plain" },
    });
  };
}

export function buildWorker() {
  const out = mkdtempSync(join(tmpdir(), "teslabot-sandbox-"));
  execFileSync(
    join(root, "node_modules/.bin/wrangler"),
    [
      "deploy",
      "--dry-run",
      "--outdir",
      out,
      "--config",
      join(root, "wrangler.example.jsonc"),
    ],
    { cwd: root, stdio: "pipe" },
  );
  return join(out, "index.js");
}

const hex = (bytes = 32) => randomBytes(bytes).toString("hex");

export async function startSandbox({
  location = false,
  script = buildWorker(),
} = {}) {
  // Production defaults from wrangler.example.jsonc; fresh secrets every run.
  const env = {
    APP_ORIGIN: ORIGIN,
    TESLA_REGION: "na",
    ENABLE_LOCATION: String(location),
    ENABLE_VEHICLE_COMMANDS: "false",
    ALLOW_VEHICLE_WAKE: "false",
    MAX_REQUESTS_PER_DAY: "50",
    MAX_ESTIMATED_MONTHLY_SPEND_USD: "5",
    CACHE_TTL_SECONDS: "300",
    TESLA_CLIENT_ID: randomUUID(),
    TESLA_CLIENT_SECRET: "ta-secret." + hex(16),
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    ADMIN_TOKEN: hex(),
    MCP_TOKEN: hex(),
    TELEMETRY_HOSTNAME: "telemetry.sandbox.test",
    TELEMETRY_PORT: "443",
    TELEMETRY_CA:
      "-----BEGIN CERTIFICATE-----\nc2FuZGJveA==\n-----END CERTIFICATE-----\n",
    TELEMETRY_RELAY_TOKEN: hex(),
    TELEMETRY_INGEST_TOKEN: hex(),
  };
  const mock = new MockTesla({
    origin: ORIGIN,
    client_id: env.TESLA_CLIENT_ID,
    client_secret: env.TESLA_CLIENT_SECRET,
    relay_token: env.TELEMETRY_RELAY_TOKEN,
  });
  const publicKey = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }).publicKey;
  const logs: string[] = [];
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      name: "teslabot",
      modules: true,
      scriptPath: script,
      // Module names are relative to this root; a bundle outside it fails to load.
      modulesRoot: dirname(script),
      compatibilityDate: "2026-10-18",
      d1Databases: ["DB"],
      bindings: env,
      serviceBindings: {
        ASSETS: adapt(assets(publicKey)),
        TELEMETRY: adapt((request) => mock.signer(request)),
      },
      outboundService: adapt((request) => mock.fetch(request)),
      handleStructuredLogs: (log) => logs.push(`${log.level}: ${log.message}`),
    }),
  );
  await mf.ready;
  const DB = (await mf.getD1Database("DB")) as unknown as D1Database;
  const migrations = join(root, "migrations");
  for (const file of readdirSync(migrations)
    .filter((name) => name.endsWith(".sql"))
    .sort())
    await DB.exec(
      readFileSync(join(migrations, file), "utf8").replace(/\n/g, " "),
    );
  const worker = await mf.getWorker();
  // Requests the way a client reaches the deployed origin.
  const dispatch: typeof fetch = (input, init) =>
    mf.dispatchFetch(String(input instanceof Request ? input.url : input), {
      redirect: "manual",
      ...init,
    } as never) as unknown as Promise<Response>;
  // Direct access to an account's encrypted records, for simulating time.
  const store = (account = "") =>
    new Store({ ...env, DB } as unknown as Env, undefined, account);
  return {
    env,
    mock,
    mf,
    DB,
    logs,
    dispatch,
    publicKey,
    store,
    // Time passing for the cached reading: it becomes `minutes` older.
    async passTime(account: string, minutes: number) {
      const records = store(account);
      const summary = await records.get<any>("summary");
      if (!summary) return;
      const back = (iso: string | null) =>
        iso && new Date(Date.parse(iso) - minutes * 60000).toISOString();
      summary.data.retrieved_at = back(summary.data.retrieved_at);
      summary.data.observed_at = back(summary.data.observed_at);
      for (const part of Object.values<any>(summary.data.sections ?? {}))
        part.observed_at = back(part.observed_at);
      if (summary.location)
        summary.location.observed_at = back(summary.location.observed_at);
      await records.put("summary", summary);
    },
    // Hours later: teslabot's stored token is due for refresh and Tesla no
    // longer accepts the old access token.
    async expireTokens(account: string, identity: string) {
      const records = store(account);
      const tokens = await records.get<any>("owner_tokens");
      mock.expireAccessTokens(identity);
      if (tokens)
        await records.put("owner_tokens", {
          ...tokens,
          expires_at: Date.now() - 1000,
        });
      return tokens;
    },
    async accounts() {
      const { results } = await DB.prepare("SELECT id FROM accounts").all<{
        id: string;
      }>();
      return results.map((row) => row.id);
    },
    // The cron trigger, as Cloudflare fires it.
    scheduled: () =>
      worker.scheduled({ cron: "*/10 * * * *", scheduledTime: new Date() }),
    async mcp(token: string, name = "sandbox-assistant") {
      const client = new Client({ name, version: "1.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(ORIGIN + "/mcp"), {
          fetch: dispatch,
          requestInit: { headers: { Authorization: "Bearer " + token } },
        }),
      );
      return client;
    },
    close: () => mf.dispose(),
  };
}
export type Sandbox = Awaited<ReturnType<typeof startSandbox>>;

export interface Reply {
  status: number;
  location: string | null;
  cookies: string[];
  body: any;
}

// A browser for one person: keeps its cookies, sends Origin on writes and
// Accept: text/html on navigations, like the dashboard does.
export class Browser {
  readonly jar = new Map<string, string>();
  constructor(private sandbox: Sandbox) {}
  async go(
    path: string,
    {
      method = "GET",
      body,
      bearer,
      navigate = false,
    }: {
      method?: string;
      body?: unknown;
      bearer?: string;
      navigate?: boolean;
    } = {},
  ): Promise<Reply> {
    const headers = new Headers();
    if (this.jar.size)
      headers.set(
        "Cookie",
        [...this.jar].map(([name, value]) => `${name}=${value}`).join("; "),
      );
    if (method !== "GET") headers.set("Origin", ORIGIN);
    if (navigate) headers.set("Accept", "text/html,application/xhtml+xml");
    if (bearer) headers.set("Authorization", "Bearer " + bearer);
    if (body !== undefined) headers.set("Content-Type", "application/json");
    const url = path.startsWith("https://") ? path : ORIGIN + path;
    const response = await this.sandbox.dispatch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const cookies = response.headers.getSetCookie();
    for (const cookie of cookies) {
      const [pair] = cookie.split(";");
      const [name, value] = [
        pair.slice(0, pair.indexOf("=")),
        pair.slice(pair.indexOf("=") + 1),
      ];
      if (/Max-Age=0/i.test(cookie) || !value) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    return {
      status: response.status,
      location: response.headers.get("Location"),
      cookies,
      body: parsed,
    };
  }
}
