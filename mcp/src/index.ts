import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./server";
import { loadConfig } from "./config";
const config = loadConfig();
serveStdio(() => createServer(config.origin, config.token));
