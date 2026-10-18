import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
const output = "dist/teslabot";
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp("plugin/teslabot", output, { recursive: true });
await build({
  entryPoints: ["mcp/src/index.ts"],
  outfile: output + "/server/index.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  packages: "bundle",
  logLevel: "warning",
});
console.log(
  "Local plugin built at dist/teslabot. Supply TESLABOT_CONFIG securely through the host environment.",
);
