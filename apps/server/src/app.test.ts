import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getServerConfig } from "@patchpage/config";
import type { ServerConfig } from "@patchpage/config";
import { JsonFilePatchPageDb } from "@patchpage/db";
import type { RecordUploadInput, RecordUploadResult } from "@patchpage/db";
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
  it("returns uploaded draft URLs on the configured public origin", async () => {
    const publicBaseUrl = "https://drafts.self-hoster.dev";
    const apiToken = "configured-origin-token";
    const config = getServerConfig({
      PATCHPAGE_PUBLIC_BASE_URL: publicBaseUrl
    });
    const db = new JsonFilePatchPageDb(path.join(tempDir, "configured-origin-db.json"));
    await db.initialize(apiToken);
    const storage = new FileSystemHtmlStorage(path.join(tempDir, "configured-origin-drafts"));
    const app = createApp({ config, db, storage });

    const upload = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { authorization: `Bearer ${apiToken}` },
      payload: {
        html: "<!doctype html><html><head><title>Configured Origin</title></head><body></body></html>"
      }
    });

    expect(upload.statusCode).toBe(201);
    const body = upload.json() as {
      draftId: string;
      publicUrl: string;
      versionNumber: number;
    };
    expect(body.draftId).toMatch(/^[a-z0-9]{12}$/);
    expect(body.versionNumber).toBe(1);
    expect(body.publicUrl).toBe(`${publicBaseUrl}/d/${body.draftId}`);

    await app.close();
    await db.close();
  });

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

  it("persists the direct socket address when proxy trust is not configured", async () => {
    const sourceIp = await uploadSourceIp({
      remoteAddress: "192.0.2.10"
    });

    expect(sourceIp).toEqual({
      versionSourceIp: "192.0.2.10",
      eventSourceIp: "192.0.2.10"
    });
  });

  it("persists the client address attributed through a trusted multi-hop proxy chain", async () => {
    const sourceIp = await uploadSourceIp({
      trustProxy: "2",
      remoteAddress: "10.0.0.5",
      forwardedFor: "203.0.113.9, 198.51.100.7"
    });

    expect(sourceIp).toEqual({
      versionSourceIp: "203.0.113.9",
      eventSourceIp: "203.0.113.9"
    });
  });

  it("ignores a spoofed forwarding header on a direct request by default", async () => {
    const sourceIp = await uploadSourceIp({
      remoteAddress: "192.0.2.10",
      forwardedFor: "203.0.113.9, 198.51.100.7"
    });

    expect(sourceIp).toEqual({
      versionSourceIp: "192.0.2.10",
      eventSourceIp: "192.0.2.10"
    });
  });

  it("attributes the rightmost forwarded address through one trusted proxy hop", async () => {
    const sourceIp = await uploadSourceIp({
      trustProxy: "1",
      remoteAddress: "10.0.0.5",
      forwardedFor: "203.0.113.9, 198.51.100.7"
    });

    expect(sourceIp).toEqual({
      versionSourceIp: "198.51.100.7",
      eventSourceIp: "198.51.100.7"
    });
  });

  it("attributes the first untrusted address beyond configured proxy networks", async () => {
    const sourceIp = await uploadSourceIp({
      trustProxy: "10.0.0.0/8, 198.51.100.0/24",
      remoteAddress: "10.0.0.5",
      forwardedFor: "203.0.113.9, 198.51.100.7"
    });

    expect(sourceIp).toEqual({
      versionSourceIp: "203.0.113.9",
      eventSourceIp: "203.0.113.9"
    });
  });

  it("ignores a spoofed forwarding chain from outside configured proxy networks", async () => {
    const sourceIp = await uploadSourceIp({
      trustProxy: "10.0.0.0/8",
      remoteAddress: "192.0.2.10",
      forwardedFor: "203.0.113.9, 10.0.0.5"
    });

    expect(sourceIp).toEqual({
      versionSourceIp: "192.0.2.10",
      eventSourceIp: "192.0.2.10"
    });
  });

  it.each([
    "::ffff:0:0/96",
    "::0.0.0.0/96",
    "::192.0.2.10",
    "::192.0.2.0/120",
    "::/1",
    "0.0.0.0/1,128.0.0.0/1",
    "::ffff:10.0.0.0/104",
    "0:0:0:0:0:ffff:a00:0/104",
    "::fffe:0:0/95",
    "::ffff:0:0/95"
  ])(
    "rejects effective blanket trust %s before a direct peer can spoof attribution",
    async (trustProxy) => {
      await expect(
        uploadSourceIp({
          trustProxy,
          remoteAddress: "192.0.2.10",
          forwardedFor: "203.0.113.9"
        })
      ).rejects.toThrow(/Invalid PATCHPAGE_TRUST_PROXY/);
    }
  );
  it("rejects an unknown client-supplied draft ID without creating a public draft", async () => {
    const config = testConfig();
    const db = new JsonFilePatchPageDb(path.join(tempDir, "unknown-update-db.json"));
    await db.initialize("dev-token");
    const storage = new FileSystemHtmlStorage(path.join(tempDir, "unknown-update-drafts"));
    const app = createApp({ config, db, storage });
    const draftId = "abcdefghijkl";

    const upload = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { authorization: "Bearer dev-token" },
      payload: {
        draftId,
        html: "<!doctype html><html><head><title>Must not exist</title></head><body></body></html>"
      }
    });

    expect(upload.statusCode).toBe(404);
    expect(upload.json()).toEqual({ ok: false, error: "Draft not found." });
    const viewer = await app.inject({ method: "GET", url: `/d/${draftId}` });
    expect(viewer.statusCode).toBe(404);
    expect(await listFiles(storage.rootDir)).toEqual([]);

    await app.close();
    await db.close();
  });

  it("returns the same response for unavailable update targets", async () => {
    const config = testConfig();
    const db = new JsonFilePatchPageDb(path.join(tempDir, "unavailable-update-db.json"));
    await db.initialize("dev-token");
    const auth = await db.findApiTokenByToken("dev-token");
    if (!auth) throw new Error("Expected bootstrap authentication.");
    const storage = new FileSystemHtmlStorage(path.join(tempDir, "unavailable-update-drafts"));
    const app = createApp({ config, db, storage });
    const unknownDraftId = "aaaaaaaaaaaa";
    const foreignDraftId = "bbbbbbbbbbbb";
    const deletedDraftId = "cccccccccccc";
    const disabledDraftId = "dddddddddddd";

    for (const [draftId, accountId] of [
      [foreignDraftId, "acct_another"],
      [deletedDraftId, auth.accountId],
      [disabledDraftId, auth.accountId]
    ]) {
      await db.recordUpload({
        intent: "create",
        draftId,
        versionId: `ver_${draftId}`,
        accountId,
        apiTokenId: auth.id,
        title: "Existing target",
        objectKey: `drafts/${draftId}/versions/seed.html`,
        contentHash: "sha256:seed",
        fileSize: 1,
        filename: "seed.html",
        metadata: {},
        sourceIp: null,
        userAgent: "vitest"
      });
    }
    await db.deleteDraft(deletedDraftId, auth.accountId);
    await db.disableDraft(disabledDraftId, auth.accountId, "policy");

    const responses = await Promise.all(
      [unknownDraftId, foreignDraftId, deletedDraftId, disabledDraftId].map((draftId) =>
        app.inject({
          method: "POST",
          url: "/api/uploads",
          headers: { authorization: "Bearer dev-token" },
          payload: {
            draftId,
            html: "<!doctype html><html><head><title>Update</title></head><body></body></html>"
          }
        })
      )
    );

    for (const response of responses) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ ok: false, error: "Draft not found." });
    }

    await app.close();
    await db.close();
  });

  it("updates an existing owned draft and preserves its previous version", async () => {
    const config = testConfig();
    const db = new JsonFilePatchPageDb(path.join(tempDir, "owned-update-db.json"));
    await db.initialize("dev-token");
    const storage = new FileSystemHtmlStorage(path.join(tempDir, "owned-update-drafts"));
    const app = createApp({ config, db, storage });
    const headers = { authorization: "Bearer dev-token" };

    const created = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers,
      payload: {
        html: "<!doctype html><html><head><title>Original</title></head><body>original-marker</body></html>"
      }
    });
    const createBody = created.json() as { draftId: string; versionNumber: number };

    const updated = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers,
      payload: {
        draftId: createBody.draftId,
        html: "<!doctype html><html><head><title>Updated</title></head><body>updated-marker</body></html>"
      }
    });

    expect(created.statusCode).toBe(201);
    expect(createBody.versionNumber).toBe(1);
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      draftId: createBody.draftId,
      versionNumber: 2,
      title: "Updated"
    });

    const currentViewer = await app.inject({
      method: "GET",
      url: `/d/${createBody.draftId}`
    });
    const originalViewer = await app.inject({
      method: "GET",
      url: `/d/${createBody.draftId}/v/1`
    });
    expect(currentViewer.statusCode).toBe(200);
    expect(currentViewer.body).toContain("updated-marker");
    expect(currentViewer.body).not.toContain("original-marker");
    expect(originalViewer.statusCode).toBe(200);
    expect(originalViewer.body).toContain("original-marker");

    await app.close();
    await db.close();
  });

  it("does not hold metadata locks while object storage is slow", async () => {
    const config = testConfig();
    const db = new JsonFilePatchPageDb(path.join(tempDir, "slow-storage-db.json"));
    await db.initialize("dev-token");
    const auth = await db.findApiTokenByToken("dev-token");
    if (!auth) throw new Error("Expected bootstrap authentication.");
    const storage = new ControlledHtmlStorage(path.join(tempDir, "slow-storage-drafts"));
    const app = createApp({ config, db, storage });
    const created = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { authorization: "Bearer dev-token" },
      payload: {
        html: "<!doctype html><html><head><title>Slow target</title></head><body></body></html>"
      }
    });
    const createdBody = created.json();
    const unrelatedDraftId = "eeeeeeeeeeee";
    await db.recordUpload({
      intent: "create",
      draftId: unrelatedDraftId,
      versionId: "ver_unrelated",
      accountId: auth.accountId,
      apiTokenId: auth.id,
      title: "Unrelated",
      objectKey: `drafts/${unrelatedDraftId}/versions/ver_unrelated.html`,
      contentHash: "sha256:unrelated",
      fileSize: 1,
      filename: "unrelated.html",
      metadata: {},
      sourceIp: null,
      userAgent: "vitest"
    });

    const writeStarted = Promise.withResolvers<void>();
    const allowWrite = Promise.withResolvers<void>();
    storage.afterPut = async () => {
      writeStarted.resolve();
      await allowWrite.promise;
    };

    try {
      const update = app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { authorization: "Bearer dev-token" },
        payload: {
          draftId: createdBody.draftId,
          html: "<!doctype html><html><head><title>Slow update</title></head><body></body></html>"
        }
      });
      await writeStarted.promise;

      const disable = db.disableDraft(
        unrelatedDraftId,
        auth.accountId,
        "unrelated policy action"
      );
      // Await the operation itself rather than racing the filesystem against a
      // short wall-clock deadline. The test timeout remains the deadlock watchdog.
      await expect(disable).resolves.toBe(true);

      allowWrite.resolve();
      await expect(update).resolves.toMatchObject({ statusCode: 200 });
    } finally {
      allowWrite.resolve();
      await app.close();
      await db.close();
    }
  }, 10_000);

  it("removes only the new object when final eligibility recheck rejects", async () => {
    const config = testConfig();
    const db = new JsonFilePatchPageDb(path.join(tempDir, "race-cleanup-db.json"));
    await db.initialize("dev-token");
    const auth = await db.findApiTokenByToken("dev-token");
    if (!auth) throw new Error("Expected bootstrap authentication.");
    const storage = new ControlledHtmlStorage(path.join(tempDir, "race-cleanup-drafts"));
    const app = createApp({ config, db, storage });
    const created = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { authorization: "Bearer dev-token" },
      payload: {
        html: "<!doctype html><html><head><title>Original</title></head><body>original</body></html>"
      }
    });
    const createdBody = created.json();
    const originalKey =
      `drafts/${createdBody.draftId}/versions/${createdBody.versionId}.html`;
    storage.afterPut = async () => {
      await db.disableDraft(createdBody.draftId, auth.accountId, "policy race");
    };

    const update = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { authorization: "Bearer dev-token" },
      payload: {
        draftId: createdBody.draftId,
        html: "<!doctype html><html><head><title>Rejected</title></head><body>rejected</body></html>"
      }
    });

    expect(update.statusCode).toBe(404);
    expect(update.json()).toEqual({ ok: false, error: "Draft not found." });
    expect(await listFiles(storage.rootDir)).toEqual([originalKey]);
    await expect(storage.getHtmlObject(originalKey)).resolves.toContain("original");

    await app.close();
    await db.close();
  });

  it("does not mutate metadata when object storage fails", async () => {
    const config = testConfig();
    const db = new JsonFilePatchPageDb(path.join(tempDir, "storage-failure-db.json"));
    await db.initialize("dev-token");
    const storage = new ControlledHtmlStorage(path.join(tempDir, "storage-failure-drafts"));
    const app = createApp({ config, db, storage });
    const created = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { authorization: "Bearer dev-token" },
      payload: {
        html: "<!doctype html><html><head><title>Original</title></head><body>original</body></html>"
      }
    });
    const createdBody = created.json();
    storage.putError = new Error("Object storage unavailable.");

    const update = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { authorization: "Bearer dev-token" },
      payload: {
        draftId: createdBody.draftId,
        html: "<!doctype html><html><head><title>Failed</title></head><body>failed</body></html>"
      }
    });

    expect(update.statusCode).toBe(500);
    const current = await db.findDraftVersion(createdBody.draftId);
    expect(current.version?.id).toBe(createdBody.versionId);
    expect(await listFiles(storage.rootDir)).toEqual([
      `drafts/${createdBody.draftId}/versions/${createdBody.versionId}.html`
    ]);

    await app.close();
    await db.close();
  });

  it("surfaces cleanup failure instead of masking an orphan as a safe rejection", async () => {
    const config = testConfig();
    const db = new JsonFilePatchPageDb(path.join(tempDir, "cleanup-failure-db.json"));
    await db.initialize("dev-token");
    const auth = await db.findApiTokenByToken("dev-token");
    if (!auth) throw new Error("Expected bootstrap authentication.");
    const storage = new ControlledHtmlStorage(path.join(tempDir, "cleanup-failure-drafts"));
    const app = createApp({ config, db, storage });
    const created = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { authorization: "Bearer dev-token" },
      payload: {
        html: "<!doctype html><html><head><title>Original</title></head><body></body></html>"
      }
    });
    const createdBody = created.json();
    storage.afterPut = async () => {
      await db.disableDraft(createdBody.draftId, auth.accountId, "policy race");
    };
    storage.deleteError = new Error("Cleanup unavailable.");

    const update = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { authorization: "Bearer dev-token" },
      payload: {
        draftId: createdBody.draftId,
        html: "<!doctype html><html><head><title>Rejected</title></head><body></body></html>"
      }
    });

    expect(update.statusCode).toBe(500);
    expect(update.json()).toEqual({ ok: false, error: "Internal server error." });
    expect(await listFiles(storage.rootDir)).toHaveLength(2);

    await app.close();
    await db.close();
  });

  it("keeps the new object when metadata commit outcome is indeterminate", async () => {
    const config = testConfig();
    const db = new CommitIndeterminateJsonDb(path.join(tempDir, "indeterminate-db.json"));
    await db.initialize("dev-token");
    const storage = new ControlledHtmlStorage(path.join(tempDir, "indeterminate-drafts"));
    const app = createApp({ config, db, storage });
    const created = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { authorization: "Bearer dev-token" },
      payload: {
        html: "<!doctype html><html><head><title>Original</title></head><body></body></html>"
      }
    });
    const createdBody = created.json();
    db.throwAfterRecord = true;

    const update = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { authorization: "Bearer dev-token" },
      payload: {
        draftId: createdBody.draftId,
        html: "<!doctype html><html><head><title>Committed</title></head><body>committed</body></html>"
      }
    });

    expect(update.statusCode).toBe(500);
    const current = await db.findDraftVersion(createdBody.draftId);
    expect(current.version?.versionNumber).toBe(2);
    if (!current.version) throw new Error("Expected committed version.");
    expect(await listFiles(storage.rootDir)).toHaveLength(2);
    await expect(storage.getHtmlObject(current.version.objectKey)).resolves.toContain(
      "committed"
    );

    await app.close();
    await db.close();
  });

  it("accepts the released CLI null draft marker as server-generated create intent", async () => {
    const config = testConfig();
    const db = new JsonFilePatchPageDb(path.join(tempDir, "legacy-null-db.json"));
    await db.initialize("dev-token");
    const storage = new FileSystemHtmlStorage(path.join(tempDir, "legacy-null-drafts"));
    const app = createApp({ config, db, storage });

    const upload = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { authorization: "Bearer dev-token" },
      payload: {
        html: "<!doctype html><html><head><title>Released CLI</title></head><body></body></html>",
        filename: "released-cli.html",
        draftId: null,
        metadata: {
          cliVersion: "0.1.0",
          fileSha256: "legacy-client-hash"
        }
      }
    });

    expect(upload.statusCode).toBe(201);
    const response = upload.json();
    expect(response.draftId).toMatch(/^[a-z0-9]{12}$/);
    expect(response.versionNumber).toBe(1);

    await app.close();
    await db.close();
  });

  it("rejects invalid non-null draft IDs instead of treating them as creates", async () => {
    const config = testConfig();
    const db = new JsonFilePatchPageDb(path.join(tempDir, "explicit-intent-db.json"));
    await db.initialize("dev-token");
    const storage = new FileSystemHtmlStorage(path.join(tempDir, "explicit-intent-drafts"));
    const app = createApp({ config, db, storage });

    for (const draftId of ["", 123]) {
      const upload = await app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { authorization: "Bearer dev-token" },
        payload: {
          draftId,
          html: "<!doctype html><html><head><title>Invalid target</title></head><body></body></html>"
        }
      });

      expect(upload.statusCode).toBe(400);
      expect(upload.json()).toEqual({ ok: false, error: "Invalid draft ID." });
    }

    await app.close();
    await db.close();
  });
});

interface SourceIpAttribution {
  versionSourceIp: string | null | undefined;
  eventSourceIp: string | null | undefined;
}

async function uploadSourceIp(options: {
  trustProxy?: string;
  remoteAddress: string;
  forwardedFor?: string;
}): Promise<SourceIpAttribution> {
  const apiToken = "trusted-proxy-token";
  const config = getServerConfig(
    options.trustProxy === undefined ? {} : { PATCHPAGE_TRUST_PROXY: options.trustProxy }
  );
  const dbFile = path.join(tempDir, "trusted-proxy-db.json");
  const db = new JsonFilePatchPageDb(dbFile);
  await db.initialize(apiToken);
  const storage = new FileSystemHtmlStorage(path.join(tempDir, "trusted-proxy-drafts"));
  const app = createApp({ config, db, storage });

  try {
    const upload = await app.inject({
      method: "POST",
      url: "/api/uploads",
      remoteAddress: options.remoteAddress,
      headers: {
        authorization: `Bearer ${apiToken}`,
        ...(options.forwardedFor === undefined ? {} : { "x-forwarded-for": options.forwardedFor })
      },
      payload: {
        html: "<!doctype html><html><head><title>Trusted Proxy</title></head><body></body></html>"
      }
    });

    expect(upload.statusCode).toBe(201);
    const { draftId, versionId } = upload.json() as { draftId: string; versionId: string };
    const lookup = await db.findDraftVersion(draftId);
    const state = JSON.parse(await readFile(dbFile, "utf8")) as {
      uploadEvents: Array<{ draftVersionId: string; sourceIp: string | null }>;
    };
    const event = state.uploadEvents.find((row) => row.draftVersionId === versionId);

    return {
      versionSourceIp: lookup.version?.sourceIp,
      eventSourceIp: event?.sourceIp
    };
  } finally {
    await app.close();
    await db.close();
  }
}

function testConfig(): ServerConfig {
  return {
    port: 3000,
    publicBaseUrl: "http://localhost:3000",
    trustProxy: false,
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

class ControlledHtmlStorage extends FileSystemHtmlStorage {
  afterPut: (() => Promise<void>) | null = null;
  putError: Error | null = null;
  deleteError: Error | null = null;

  override async putHtmlObject(key: string, html: string): Promise<void> {
    if (this.putError) throw this.putError;
    await super.putHtmlObject(key, html);
    if (this.afterPut) await this.afterPut();
  }

  override async deleteHtmlObject(key: string): Promise<void> {
    if (this.deleteError) throw this.deleteError;
    await super.deleteHtmlObject(key);
  }
}

class CommitIndeterminateJsonDb extends JsonFilePatchPageDb {
  throwAfterRecord = false;

  override async recordUpload(input: RecordUploadInput): Promise<RecordUploadResult> {
    const result = await super.recordUpload(input);
    if (this.throwAfterRecord) {
      throw new Error("JSON metadata commit outcome is indeterminate.");
    }
    return result;
  }
}

async function listFiles(rootDir: string, currentDir = rootDir): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(rootDir, entryPath)));
    } else if (entry.isFile()) {
      files.push(path.relative(rootDir, entryPath));
    }
  }
  return files.sort();
}
