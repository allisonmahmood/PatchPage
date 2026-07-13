import { writeFileSync } from "node:fs";

const reportPath = process.env.PATCHPAGE_TEST_TTY_REPORT;
const inputError = process.env.PATCHPAGE_TEST_TTY_INPUT_ERROR;
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
    if (isRaw && inputError) {
      queueMicrotask(() => input.emit("error", new Error(inputError)));
    }
    return input;
  }
});

process.on("exit", () => {
  if (reportPath) {
    const signalHandlerCounts = Object.fromEntries(
      ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => [signal, process.listenerCount(signal)])
    );
    writeFileSync(
      reportPath,
      JSON.stringify({ finalRaw: isRaw, rawModeChanges, signalHandlerCounts })
    );
  }
});
