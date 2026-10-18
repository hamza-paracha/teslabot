import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./server";
serveStdio(() =>
  createServer(
    process.env.TESLABOT_URL ?? "",
    process.env.TESLABOT_MCP_TOKEN ?? "",
  ),
);
