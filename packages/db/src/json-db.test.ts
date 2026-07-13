import { chmod, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonFilePatchPageDb } from "./json-db.js";

let tempDir: string;
const supportsPosixPermissionTest =
  process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "patchpage-db-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("JsonFilePatchPageDb", () => {
  it("initializes bootstrap auth and records draft uploads", async () => {
    const db = new JsonFilePatchPageDb(path.join(tempDir, "db.json"));
    await db.initialize("dev-token");

    const auth = await db.findApiTokenByToken("dev-token");
    expect(auth?.accountId).toBe("acct_bootstrap");

    const upload = await db.recordUpload({
      draftId: "abcdefghijkl",
      versionId: "ver_one",
      accountId: auth!.accountId,
      apiTokenId: auth!.id,
      title: "First draft",
      objectKey: "drafts/abcdefghijkl/versions/ver_one.html",
      contentHash: "sha256:test",
      fileSize: 12,
      filename: "plan.html",
      metadata: { cliVersion: "test" },
      sourceIp: "127.0.0.1",
      userAgent: "vitest"
    });

    expect(upload.versionNumber).toBe(1);

    const lookup = await db.findDraftVersion("abcdefghijkl");
    expect(lookup.draft?.title).toBe("First draft");
    expect(lookup.version?.objectKey).toBe("drafts/abcdefghijkl/versions/ver_one.html");
  });

  it("preserves concurrent uploads made through database instances sharing one file", async () => {
    const filePath = path.join(tempDir, "db.json");
    const aliasedFilePath = `${tempDir}${path.sep}.${path.sep}db.json`;
    const setupDb = new JsonFilePatchPageDb(filePath);
    await setupDb.initialize("dev-token");

    const auth = await setupDb.findApiTokenByToken("dev-token");
    expect(auth).not.toBeNull();

    const uploads = Array.from({ length: 8 }, (_, index) => {
      const draftId = `draft_${index}`;
      const versionId = `ver_${index}`;
      const db = new JsonFilePatchPageDb(index % 2 === 0 ? filePath : aliasedFilePath);

      return {
        draftId,
        versionId,
        objectKey: `drafts/${draftId}/versions/${versionId}.html`,
        promise: db.recordUpload({
          draftId,
          versionId,
          accountId: auth!.accountId,
          apiTokenId: auth!.id,
          title: `Draft ${index}`,
          objectKey: `drafts/${draftId}/versions/${versionId}.html`,
          contentHash: `sha256:${index}`,
          fileSize: index + 1,
          filename: `plan-${index}.html`,
          metadata: { cliVersion: "test" },
          sourceIp: "127.0.0.1",
          userAgent: "vitest"
        })
      };
    });

    await Promise.all(uploads.map((upload) => upload.promise));

    for (const upload of uploads) {
      const lookup = await setupDb.findDraftVersion(upload.draftId);
      expect(lookup.version?.id).toBe(upload.versionId);
      expect(lookup.version?.objectKey).toBe(upload.objectKey);
    }
  });

  it("preserves concurrent token creates and successful token-use updates", async () => {
    const filePath = path.join(tempDir, "db.json");
    const setupDb = new JsonFilePatchPageDb(filePath);
    await setupDb.initialize("dev-token");

    const tokens = Array.from({ length: 6 }, (_, index) => `created-token-${index}`);
    const mutations = tokens.map((token, index) =>
      new JsonFilePatchPageDb(filePath).createApiToken({
        accountId: "acct_bootstrap",
        name: `Token ${index}`,
        token,
        scopes: ["upload"]
      })
    );
    const bootstrapUse = new JsonFilePatchPageDb(filePath).findApiTokenByToken("dev-token");

    const [createdTokens, bootstrapAuth] = await Promise.all([
      Promise.all(mutations),
      bootstrapUse
    ]);
    expect(createdTokens).toHaveLength(tokens.length);
    expect(bootstrapAuth?.id).toBe("tok_bootstrap");

    for (const token of tokens) {
      const auth = await setupDb.findApiTokenByToken(token);
      expect(auth?.accountId).toBe("acct_bootstrap");
    }

    const persisted = JSON.parse(await readFile(filePath, "utf8")) as {
      apiTokens: Array<{ id: string; lastUsedAt: string | null }>;
    };
    expect(persisted.apiTokens.find((token) => token.id === "tok_bootstrap")?.lastUsedAt).toEqual(
      expect.any(String)
    );
  });

  it("preserves a concurrent bootstrap update and token create", async () => {
    const filePath = path.join(tempDir, "db.json");
    const setupDb = new JsonFilePatchPageDb(filePath);
    await setupDb.initialize("dev-token");

    const bootstrapUpdate = new JsonFilePatchPageDb(filePath).initialize("rotated-token");
    const tokenCreate = new JsonFilePatchPageDb(filePath).createApiToken({
      accountId: "acct_bootstrap",
      name: "Concurrent token",
      token: "concurrent-token",
      scopes: ["upload"]
    });
    await Promise.all([bootstrapUpdate, tokenCreate]);

    const rotatedAuth = await setupDb.findApiTokenByToken("rotated-token");
    const createdAuth = await setupDb.findApiTokenByToken("concurrent-token");
    expect(rotatedAuth?.id).toBe("tok_bootstrap");
    expect(createdAuth?.accountId).toBe("acct_bootstrap");
  });

  it("preserves concurrent successful draft disables and deletes", async () => {
    const filePath = path.join(tempDir, "db.json");
    const setupDb = new JsonFilePatchPageDb(filePath);
    await setupDb.initialize("dev-token");
    const auth = await setupDb.findApiTokenByToken("dev-token");
    expect(auth).not.toBeNull();

    for (const draftId of ["draft_to_disable", "draft_to_delete"]) {
      await setupDb.recordUpload({
        draftId,
        versionId: `ver_${draftId}`,
        accountId: auth!.accountId,
        apiTokenId: auth!.id,
        title: draftId,
        objectKey: `drafts/${draftId}/versions/one.html`,
        contentHash: `sha256:${draftId}`,
        fileSize: 1,
        filename: "plan.html",
        metadata: {},
        sourceIp: null,
        userAgent: "vitest"
      });
    }

    const [disabled, deleted] = await Promise.all([
      new JsonFilePatchPageDb(filePath).disableDraft(
        "draft_to_disable",
        auth!.accountId,
        "policy"
      ),
      new JsonFilePatchPageDb(filePath).deleteDraft("draft_to_delete", auth!.accountId)
    ]);
    expect(disabled).toBe(true);
    expect(deleted).toBe(true);

    const disabledLookup = await setupDb.findDraftVersion("draft_to_disable");
    const deletedLookup = await setupDb.findDraftVersion("draft_to_delete");
    expect(disabledLookup.draft).toBeNull();
    expect(deletedLookup.draft).toBeNull();
  });

  it("rejects a truncated state without changing it or disclosing sensitive values", async () => {
    const filePath = path.join(tempDir, "db.json");
    const original = Buffer.from('{"accounts":[{"name":"persisted-secret"}');
    await writeFile(filePath, original);

    const error = await new JsonFilePatchPageDb(filePath)
      .initialize("bootstrap-secret")
      .then(
        () => null,
        (reason: unknown) => reason
      );

    expect(await readFile(filePath)).toEqual(original);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("persisted-secret");
    expect(String(error)).not.toContain("bootstrap-secret");
  });

  it("rejects malformed state without changing it", async () => {
    const filePath = path.join(tempDir, "db.json");
    const original = Buffer.from(
      '{"accounts":not-valid-json,"persistedValue":"persisted-secret"}'
    );
    await writeFile(filePath, original);

    const error = await new JsonFilePatchPageDb(filePath)
      .initialize("bootstrap-secret")
      .then(
        () => null,
        (reason: unknown) => reason
      );

    expect(await readFile(filePath)).toEqual(original);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("persisted-secret");
    expect(String(error)).not.toContain("bootstrap-secret");
  });

  it("rejects invalid UTF-8 without changing the persisted bytes", async () => {
    const filePath = path.join(tempDir, "db.json");
    const original = Buffer.concat([
      Buffer.from('{"accounts":[{"id":"acct_one","name":"persisted-'),
      Buffer.from([0xff]),
      Buffer.from(
        '-secret","createdAt":"now","updatedAt":"now"}],"apiTokens":[],"drafts":[],"draftVersions":[],"uploadEvents":[]}'
      )
    ]);
    await writeFile(filePath, original);

    const error = await new JsonFilePatchPageDb(filePath)
      .initialize(null)
      .then(
        () => null,
        (reason: unknown) => reason
      );

    expect(await readFile(filePath)).toEqual(original);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("persisted-");
  });

  it("rejects an invalid persisted state shape without changing it", async () => {
    const filePath = path.join(tempDir, "db.json");
    const original = Buffer.from(
      JSON.stringify({
        accounts: [{ id: "persisted-secret" }],
        apiTokens: [],
        drafts: [],
        draftVersions: [],
        uploadEvents: []
      })
    );
    await writeFile(filePath, original);

    const error = await new JsonFilePatchPageDb(filePath)
      .initialize(null)
      .then(
        () => null,
        (reason: unknown) => reason
      );

    expect(await readFile(filePath)).toEqual(original);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("persisted-secret");
  });

  it.skipIf(!supportsPosixPermissionTest)(
    "rejects an unreadable state without replacing it",
    async () => {
      const filePath = path.join(tempDir, "db.json");
      const db = new JsonFilePatchPageDb(filePath);
      await db.initialize("dev-token");
      const original = await readFile(filePath);

      await chmod(filePath, 0o200);
      let error: unknown;
      try {
        error = await db.initialize("replacement-secret").then(
          () => null,
          (reason: unknown) => reason
        );
      } finally {
        await chmod(filePath, 0o600);
      }

      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain("replacement-secret");
      expect(await readFile(filePath)).toEqual(original);
    }
  );

  it.skipIf(process.platform === "win32")(
    "preserves existing file permissions across an atomic commit",
    async () => {
      const filePath = path.join(tempDir, "db.json");
      const db = new JsonFilePatchPageDb(filePath);
      await db.initialize("dev-token");
      await chmod(filePath, 0o700);

      await db.initialize("rotated-token");

      expect((await stat(filePath)).mode & 0o777).toBe(0o700);
    }
  );

  it("never exposes a partially written primary file to readers", async () => {
    const filePath = path.join(tempDir, "db.json");
    const writerDb = new JsonFilePatchPageDb(filePath);
    const readerDb = new JsonFilePatchPageDb(filePath);
    await writerDb.initialize("dev-token");
    const auth = await writerDb.findApiTokenByToken("dev-token");
    expect(auth).not.toBeNull();

    await writerDb.recordUpload({
      draftId: "stable_draft",
      versionId: "ver_stable",
      accountId: auth!.accountId,
      apiTokenId: auth!.id,
      title: "Stable draft",
      objectKey: "drafts/stable_draft/versions/ver_stable.html",
      contentHash: "sha256:stable",
      fileSize: 1,
      filename: "stable.html",
      metadata: {},
      sourceIp: null,
      userAgent: "vitest"
    });
    const openPrimary = await open(filePath, "r");

    let stopReaders = false;
    let samples = 0;
    const readerFailures: unknown[] = [];
    let openSnapshot = "";
    const readers = Array.from({ length: 4 }, async () => {
      while (!stopReaders) {
        try {
          const lookup = await readerDb.findDraftVersion("stable_draft");
          if (lookup.version?.id !== "ver_stable") {
            readerFailures.push(new Error("The committed draft disappeared."));
          }
        } catch (error) {
          readerFailures.push(error);
        }
        samples += 1;
      }
    });

    try {
      await writerDb.recordUpload({
        draftId: "large_draft",
        versionId: "ver_large",
        accountId: auth!.accountId,
        apiTokenId: auth!.id,
        title: "Large draft",
        objectKey: "drafts/large_draft/versions/ver_large.html",
        contentHash: "sha256:large",
        fileSize: 1,
        filename: "large.html",
        metadata: { padding: "x".repeat(8 * 1024 * 1024) },
        sourceIp: null,
        userAgent: "vitest"
      });
    } finally {
      stopReaders = true;
      await Promise.all(readers);
      openSnapshot = await openPrimary.readFile("utf8");
      await openPrimary.close();
    }

    const snapshot = JSON.parse(openSnapshot) as { drafts: Array<{ id: string }> };
    expect(samples).toBeGreaterThan(0);
    expect(readerFailures).toEqual([]);
    expect(snapshot.drafts.map((draft) => draft.id)).toEqual(["stable_draft"]);
  });
});
