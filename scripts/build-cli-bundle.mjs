import { chmod, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliDir = path.join(repoRoot, "packages/cli");
const distDir = path.join(cliDir, "dist");
const outfile = path.join(distDir, "index.js");

await rm(distDir, { recursive: true, force: true });

await esbuild.build({
  entryPoints: [path.join(cliDir, "src/index.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  tsconfig: path.join(cliDir, "tsconfig.json"),
  external: ["commander", "parse5"]
});

await chmod(outfile, 0o755);
