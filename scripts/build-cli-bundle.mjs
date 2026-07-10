import { access, chmod, copyFile, cp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliDir = path.join(repoRoot, "packages/cli");
const distDir = path.join(cliDir, "dist");
const outfile = path.join(distDir, "index.js");
const packageJson = JSON.parse(await readFile(path.join(cliDir, "package.json"), "utf8"));
const rootSkillsDir = path.join(repoRoot, "skills");
const packageSkillsDir = path.join(cliDir, "skills");
const rootPatchpageSkill = path.join(rootSkillsDir, "patchpage/SKILL.md");

await rm(distDir, { recursive: true, force: true });

await esbuild.build({
  entryPoints: [path.join(cliDir, "src/index.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  tsconfig: path.join(cliDir, "tsconfig.json"),
  external: ["commander", "parse5"],
  define: {
    __PATCHPAGE_VERSION__: JSON.stringify(packageJson.version)
  }
});

await chmod(outfile, 0o755);
await access(rootPatchpageSkill);
await rm(packageSkillsDir, { recursive: true, force: true });
await cp(rootSkillsDir, packageSkillsDir, { recursive: true });
await copyFile(path.join(repoRoot, "LICENSE"), path.join(cliDir, "LICENSE"));
