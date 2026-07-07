import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerConfig } from "@patchpage/config";
import { JsonFilePatchPageDb } from "@patchpage/db";
import { FileSystemHtmlStorage } from "@patchpage/storage";
import { createApp } from "./app.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "patchpage-server-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("PatchPage server", () => {
  it("requires auth for upload and renders uploaded drafts publicly", async () => {
    const config = testConfig();
    const db = new JsonFilePatchPageDb(path.join(tempDir, "db.json"));
    await db.initialize("dev-token");
    const storage = new FileSystemHtmlStorage(path.join(tempDir, "drafts"));
    const app = createApp({ config, db, storage });

    const unauth = await app.inject({
      method: "POST",
      url: "/api/uploads",
      payload: { html: "<title>Nope</title>" }
    });
    expect(unauth.statusCode).toBe(401);

    const upload = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { authorization: "Bearer dev-token" },
      payload: {
        html: "<!doctype html><html><head><title>Test Draft</title></head><body><h1>Hello</h1></body></html>",
        filename: "plan.html"
      }
    });
    expect(upload.statusCode).toBe(201);
    const body = upload.json() as { draftId: string; publicUrl: string };
    expect(body.publicUrl).toBe(`http://localhost:3000/d/${body.draftId}`);

    const viewer = await app.inject({ method: "GET", url: `/d/${body.draftId}` });
    expect(viewer.statusCode).toBe(200);
    expect(viewer.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(viewer.body).toContain("Test Draft");
    expect(viewer.body).toContain("class=\"draft-frame\"");
    expect(viewer.body).toContain("&lt;h1&gt;Hello&lt;/h1&gt;");
    expect(viewer.body).not.toContain("patchpage-banner");

    await app.close();
    await db.close();
  });
});

function testConfig(): ServerConfig {
  return {
    port: 3000,
    publicBaseUrl: "http://localhost:3000",
    bootstrapApiToken: "dev-token",
    allowAnonymousUploads: false,
    maxHtmlBytes: 512 * 1024,
    dbDriver: "json",
    databaseUrl: null,
    jsonDbFile: path.join(tempDir, "db.json"),
    storageDriver: "filesystem",
    storageDir: path.join(tempDir, "drafts"),
    azureStorageAccount: null,
    azureStorageContainer: null,
    azureStorageConnectionString: null
  };
}
