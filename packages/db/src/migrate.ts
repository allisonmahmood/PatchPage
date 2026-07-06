import { getServerConfig } from "@patchpage/config";
import { createPatchPageDb } from "./factory.js";

const config = getServerConfig();
const db = createPatchPageDb({
  driver: config.dbDriver,
  databaseUrl: config.databaseUrl,
  jsonDbFile: config.jsonDbFile
});

try {
  await db.initialize(config.bootstrapApiToken);
  console.log(`PatchPage ${config.dbDriver} database is initialized.`);
} finally {
  await db.close();
}
