import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createTestHarness } from "wrangler";

const origin = "https://teslabot.example";
const mcpToken = randomBytes(32).toString("hex");
const server = createTestHarness({
  workers: [
    {
      configPath: "wrangler.example.jsonc",
      vars: { APP_ORIGIN: origin },
      secrets: {
        ADMIN_TOKEN: randomBytes(32).toString("hex"),
        MCP_TOKEN: mcpToken,
        TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      },
    },
  ],
});

try {
  await server.listen();
  const worker = server.getWorker();
  await worker.applyD1Migrations("DB");

  const health = await worker.fetch(origin + "/health");
  assert.equal(health.status, 200);
  assert.partialDeepStrictEqual(await health.json(), { mode: "read_only" });

  const mcpUrl = new URL("/mcp", origin);
  assert.equal((await worker.fetch(mcpUrl)).status, 401);
  const client = new Client({ name: "workerd-smoke", version: "1.0.0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(mcpUrl, {
        fetch: worker.fetch as unknown as typeof fetch,
        requestInit: { headers: { Authorization: "Bearer " + mcpToken } },
      }),
    );
    // History exercises an in-process Worker request and D1 without a car.
    const history = await client.callTool({ name: "tesla_get_history" });
    assert.notEqual(history.isError, true, JSON.stringify(history));
    const result = history.structuredContent as { observations?: unknown };
    assert.deepEqual(result?.observations, []);
  } finally {
    await client.close();
  }

  const scheduled = await worker.scheduled({ cron: "*/10 * * * *" });
  assert.equal(scheduled.outcome, "ok", JSON.stringify(scheduled));
  console.log("workerd health, hosted MCP and scheduled event passed.");
} finally {
  await server.close();
}
