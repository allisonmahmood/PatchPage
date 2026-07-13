import { writeFileSync } from "node:fs";

const reportPath = process.env.PATCHPAGE_TEST_TTY_REPORT;
const input = process.stdin;
const output = process.stderr;
const rawModeChanges = [];
let isRaw = false;

Object.defineProperty(input, "isTTY", { configurable: true, value: true });
Object.defineProperty(output, "isTTY", { configurable: true, value: true });
Object.defineProperty(input, "isRaw", {
  configurable: true,
  get: () => isRaw
});
Object.defineProperty(input, "setRawMode", {
  configurable: true,
  value(rawMode) {
    isRaw = Boolean(rawMode);
    rawModeChanges.push(isRaw);
    return input;
  }
});

process.on("exit", () => {
  if (reportPath) {
    writeFileSync(reportPath, JSON.stringify({ finalRaw: isRaw, rawModeChanges }));
  }
});
