import { writeFileSync } from "node:fs";

const reportPath = process.env.PATCHPAGE_TEST_TTY_REPORT;
const inputError = process.env.PATCHPAGE_TEST_TTY_INPUT_ERROR;
const timeoutSignalReportPath = process.env.PATCHPAGE_TEST_TTY_TIMEOUT_SIGNAL_REPORT;
const simulatedWindowsSignal = process.env.PATCHPAGE_TEST_WINDOWS_SIGNAL;
const input = process.stdin;
const output = process.stderr;
const rawModeChanges = [];
let isRaw = false;
let windowsSignalScheduled = false;

if (timeoutSignalReportPath) {
  const timeoutSignalState = {
    ready: true,
    sigtermReceived: false,
    fallbackTriggered: false
  };
  const writeTimeoutSignalReport = () => {
    writeFileSync(timeoutSignalReportPath, JSON.stringify(timeoutSignalState));
  };
  process.on("SIGTERM", () => {
    timeoutSignalState.sigtermReceived = true;
    writeTimeoutSignalReport();
  });
  writeTimeoutSignalReport();
  setTimeout(() => {
    timeoutSignalState.fallbackTriggered = true;
    writeTimeoutSignalReport();
    process.kill(process.pid, "SIGKILL");
  }, 2_000);
  await new Promise(() => {});
}

if (simulatedWindowsSignal) {
  const kill = process.kill.bind(process);
  process.kill = (pid, signal) => {
    if (pid === process.pid && signal === simulatedWindowsSignal) {
      const error = new Error("kill ENOSYS");
      error.code = "ENOSYS";
      throw error;
    }
    return kill(pid, signal);
  };
}

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
    if (isRaw && simulatedWindowsSignal && !windowsSignalScheduled) {
      windowsSignalScheduled = true;
      queueMicrotask(() => {
        const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
        Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
        try {
          process.emit(simulatedWindowsSignal);
        } finally {
          Object.defineProperty(process, "platform", platformDescriptor);
        }
      });
    }
    return input;
  }
});

process.on("exit", () => {
  if (reportPath) {
    const signalHandlerCounts = Object.fromEntries(
      ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"].map((signal) => [
        signal,
        process.listenerCount(signal)
      ])
    );
    writeFileSync(
      reportPath,
      JSON.stringify({ finalRaw: isRaw, rawModeChanges, signalHandlerCounts })
    );
  }
});
