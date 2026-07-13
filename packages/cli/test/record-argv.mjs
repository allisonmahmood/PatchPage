import { writeFileSync } from "node:fs";

const outputPath = process.env.PATCHPAGE_TEST_ARGV_RECORD;
if (outputPath) writeFileSync(outputPath, JSON.stringify(process.argv));
