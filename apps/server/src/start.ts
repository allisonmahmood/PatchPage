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

/**
 * How often the expiry sweep runs. Nothing depends on the exact period: a
 * draft's clock decides when it expires, and this only decides how long the
 * dead row lingers afterwards. Hourly keeps that lag small without making the
 * sweep a meaningful share of what the process does.
 */
const EXPIRY_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const runExpirySweep = (): void => {
  void app.sweepExpiredDrafts().catch((error: unknown) => {
    console.error("Expiry sweep failed.", error);
  });
};

const expirySweepTimer = setInterval(runExpirySweep, EXPIRY_SWEEP_INTERVAL_MS);
// The HTTP server holds the process open; the sweep should never be the reason
// it stays up, nor the reason a shutdown waits.
expirySweepTimer.unref();

const shutdown = async (): Promise<void> => {
  clearInterval(expirySweepTimer);
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

// A restart is exactly when a backlog is most likely, so sweep once on the way
// up rather than waiting out the first interval.
runExpirySweep();
