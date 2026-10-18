import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
const schema = z
  .object({ origin: z.string(), token: z.string().min(32) })
  .strict();
export function loadConfig(env = process.env) {
  if (env.TESLABOT_CONFIG) {
    const info = statSync(env.TESLABOT_CONFIG);
    if (process.platform !== "win32" && info.mode & 0o077)
      throw Error("MCP credential file must be private (chmod 600)");
    return schema.parse(JSON.parse(readFileSync(env.TESLABOT_CONFIG, "utf8")));
  }
  return schema.parse({
    origin: env.TESLABOT_URL ?? "",
    token: env.TESLABOT_MCP_TOKEN ?? "",
  });
}
