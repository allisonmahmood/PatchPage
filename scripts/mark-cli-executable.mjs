import { chmodSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  throw new Error("Usage: node scripts/mark-cli-executable.mjs <file>");
}

chmodSync(file, 0o755);
