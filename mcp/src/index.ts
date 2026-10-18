import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./server";
serveStdio(() =>
  createServer(
    process.env.EVINTELLIGENCE_URL ?? "",
    process.env.EVINTELLIGENCE_MCP_TOKEN ?? "",
  ),
);
