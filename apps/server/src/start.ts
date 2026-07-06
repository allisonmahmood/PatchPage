import { getServerConfig } from "@patchpage/config";
import { createPatchPageDb } from "@patchpage/db";
import { createHtmlStorage } from "@patchpage/storage";
import { createApp } from "./app.js";

const config = getServerConfig();
const db = createPatchPageDb({
  driver: config.dbDriver,
  databaseUrl: config.databaseUrl,
  jsonDbFile: config.jsonDbFile
});
const storage = createHtmlStorage({
  driver: config.storageDriver,
  storageDir: config.storageDir,
  azureStorageAccount: config.azureStorageAccount,
  azureStorageContainer: config.azureStorageContainer,
  azureStorageConnectionString: config.azureStorageConnectionString
});

await db.initialize(config.bootstrapApiToken);

const app = createApp({ config, db, storage });

const shutdown = async (): Promise<void> => {
  await app.close();
  await db.close();
};

process.on("SIGINT", () => {
  shutdown().finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  shutdown().finally(() => process.exit(0));
});

await app.listen({ host: "0.0.0.0", port: config.port });
console.log(`PatchPage server listening on http://0.0.0.0:${config.port}`);
