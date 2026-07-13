import { writeFileSync } from "node:fs";

const reportPath = process.env.PATCHPAGE_TEST_SIGNAL_REPORT;
let count = 0;
let keepAlive;

process.on("SIGTERM", () => {
  count += 1;
  keepAlive ??= setTimeout(() => {}, 60_000);
  if (reportPath) {
    writeFileSync(reportPath, JSON.stringify({ signal: "SIGTERM", count }));
  }
});
