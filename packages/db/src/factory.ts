import { requireConfigValue } from "@patchpage/config";
import { JsonFilePatchPageDb } from "./json-db.js";
import { PostgresPatchPageDb } from "./postgres-db.js";
import type { DbFactoryOptions, PatchPageDb } from "./types.js";

export function createPatchPageDb(options: DbFactoryOptions): PatchPageDb {
  if (options.driver === "postgres") {
    return new PostgresPatchPageDb(requireConfigValue("DATABASE_URL", options.databaseUrl));
  }

  return new JsonFilePatchPageDb(options.jsonDbFile);
}
