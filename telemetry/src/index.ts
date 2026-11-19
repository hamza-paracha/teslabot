import { DurableObject } from "cloudflare:workers";

// The Fleet Telemetry Worker. Vehicles open mutual-TLS WebSockets to
// TELEMETRY_HOSTNAME; Spectrum hands the raw TCP connection to connect() below,
// which passes it unchanged to Tesla's fleet-telemetry server in a container.
// TLS (including the vehicle's client certificate) terminates inside the
// container, never at Cloudflare. The main Worker reaches fetch() only through
// its service binding, to have vehicle configurations signed.
export interface Env {
  TELEMETRY_SERVER: DurableObjectNamespace<TelemetryServer>;
  // Server certificate chain and key that vehicles validate against TELEMETRY_CA.
  TLS_CERT: string;
  TLS_KEY: string;
  // The partner application's P-256 private key, used only by Tesla's
  // vehicle-command proxy to sign fleet_telemetry_config.
  FLEET_PRIVATE_KEY: string;
  // The main Worker's ingest endpoint and the credentials for each direction.
  INGEST_URL: string;
  INGEST_TOKEN: string;
  RELAY_TOKEN: string;
}

const PORT_TLS = 4443;
const PORT_RELAY = 8080;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function sameToken(a: string, b: string) {
  const digest = async (value: string) =>
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    );
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  return x.every((byte, i) => byte === y[i]);
}

export class TelemetryServer extends DurableObject<Env> {
  private ensure() {
    const container = this.ctx.container!;
    if (container.running) return;
    container.start({
      enableInternet: true,
      env: {
        TLS_CERT: this.env.TLS_CERT,
        TLS_KEY: this.env.TLS_KEY,
        FLEET_PRIVATE_KEY: this.env.FLEET_PRIVATE_KEY,
        INGEST_URL: this.env.INGEST_URL,
        INGEST_TOKEN: this.env.INGEST_TOKEN,
        RELAY_TOKEN: this.env.RELAY_TOKEN,
      },
    });
  }

  // A container takes a few seconds to listen after starting; vehicles also
  // retry on their own, so give up after about 20 seconds.
  private async open(port: number) {
    this.ensure();
    for (let attempt = 0; ; attempt++) {
      const socket = this.ctx
        .container!.getTcpPort(port)
        .connect(`10.0.0.1:${port}`);
      try {
        await socket.opened;
        return socket;
      } catch (error) {
        if (attempt >= 10) throw error;
        await sleep(Math.min(250 * 2 ** attempt, 2000));
      }
    }
  }

  async connect(socket: Socket): Promise<void> {
    const upstream = await this.open(PORT_TLS);
    await Promise.allSettled([
      socket.readable.pipeTo(upstream.writable),
      upstream.readable.pipeTo(socket.writable),
    ]);
  }

  async fetch(request: Request): Promise<Response> {
    this.ensure();
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.ctx
          .container!.getTcpPort(PORT_RELAY)
          .fetch(
            new URL(new URL(request.url).pathname, "http://relay").href,
            request,
          );
      } catch (error) {
        if (attempt >= 10) throw error;
        await sleep(Math.min(250 * 2 ** attempt, 2000));
      }
    }
  }
}

const server = (env: Env) => env.TELEMETRY_SERVER.getByName("primary");

export default {
  async connect(socket: Socket, env: Env) {
    const upstream = server(env).connect("telemetry:443");
    await Promise.allSettled([
      socket.readable.pipeTo(upstream.writable),
      upstream.readable.pipeTo(socket.writable),
    ]);
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/health")
      return Response.json({ service: "teslabot-telemetry" });
    const token = request.headers
      .get("Authorization")
      ?.match(/^Bearer (.+)$/)?.[1];
    if (
      !token ||
      !env.RELAY_TOKEN ||
      env.RELAY_TOKEN.length < 32 ||
      !(await sameToken(token, env.RELAY_TOKEN))
    )
      return Response.json(
        { error: { code: "unauthorized" } },
        { status: 401 },
      );
    if (path !== "/configure" || request.method !== "POST")
      return Response.json({ error: { code: "not_found" } }, { status: 404 });
    return server(env).fetch(request);
  },
} satisfies ExportedHandler<Env>;
