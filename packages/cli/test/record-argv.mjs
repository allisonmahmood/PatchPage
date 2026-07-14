import fs, { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const readTarget = process.env.PATCHPAGE_TEST_FS_READ_TARGET;
const readMarker = process.env.PATCHPAGE_TEST_FS_READ_MARKER;
if (readTarget && readMarker) {
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function patchedReadFileSync(file, ...args) {
    if (String(file) === readTarget) writeFileSync(readMarker, "read");
    return originalReadFileSync.call(this, file, ...args);
  };
  syncBuiltinESMExports();
}

const outputPath = process.env.PATCHPAGE_TEST_ARGV_RECORD;
if (outputPath) writeFileSync(outputPath, JSON.stringify(process.argv));
