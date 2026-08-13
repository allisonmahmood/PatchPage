import { execFile as execFileCallback } from "node:child_process";
import * as fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "@patchpage/core";
import { JsonFilePatchPageDb } from "./json-db.js";
import { SCHEMA_MIGRATION_IDS, SCHEMA_MIGRATIONS } from "./migrations.js";
import type { SchemaMigration } from "./migrations.js";

/**
 * A state file at the schema deployed before migrations existed: the five row
 * collections, no ledger. New fields are added by migrating this forward.
 */
function deployedSchemaFixture(): Record<string, unknown> {
  return {
    accounts: [
      {
        id: "acct_legacy",
        name: "Legacy Account",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    ],
    apiTokens: [
      {
        id: "tok_legacy",
        accountId: "acct_legacy",
        name: "Legacy API Token",
        tokenHash: sha256("legacy-token"),
        scopes: ["upload"],
        createdAt: "2026-01-01T00:00:00.000Z",
        lastUsedAt: null,
        revokedAt: null
      }
    ],
    drafts: [
      {
        id: "legacydraft1",
        accountId: "acct_legacy",
        title: "Legacy draft",
        visibility: "unlisted",
        currentVersionId: "ver_legacy_one",
        repoOrg: null,
        repoName: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
        disabledAt: null,
        disabledReason: null
      }
    ],
    draftVersions: [
      {
        id: "ver_legacy_one",
        draftId: "legacydraft1",
        versionNumber: 1,
        objectKey: "drafts/legacydraft1/versions/ver_legacy_one.html",
        contentHash: "sha256:one",
        fileSize: 11,
        createdByApiTokenId: "tok_legacy",
        sourceIp: null,
        userAgent: null,
        cliVersion: null,
        gitBranch: null,
        gitCommitSha: null,
        originalFilename: "legacy.html",
        createdAt: "2026-01-01T00:00:00.000Z"
      }
    ],
    uploadEvents: []
  };
}

const {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} = fsPromises;
const execFile = promisify(execFileCallback);

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
      intent: "create",
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

  it("adopts a state file written before the migration ledger existed", async () => {
    const filePath = path.join(tempDir, "db.json");
    await writeFile(filePath, `${JSON.stringify(deployedSchemaFixture(), null, 2)}\n`, "utf8");

    const db = new JsonFilePatchPageDb(filePath);
    await db.initialize(null);

    expect(await db.listAppliedMigrations()).toEqual([...SCHEMA_MIGRATION_IDS]);
    const stored = JSON.parse(await readFile(filePath, "utf8")) as {
      schemaMigrations: string[];
      drafts: Array<{ id: string; title: string }>;
    };
    expect(stored.schemaMigrations).toEqual([...SCHEMA_MIGRATION_IDS]);
    expect(stored.drafts.map((draft) => draft.title)).toEqual(["Legacy draft"]);

    const auth = await db.findApiTokenByToken("legacy-token");
    expect(auth?.accountId).toBe("acct_legacy");
    const lookup = await db.findDraftVersion("legacydraft1");
    expect(lookup.version?.versionNumber).toBe(1);
    const updated = await db.recordUpload({
      intent: "update",
      draftId: "legacydraft1",
      versionId: "ver_legacy_two",
      accountId: "acct_legacy",
      apiTokenId: "tok_legacy",
      title: "Updated legacy draft",
      objectKey: "drafts/legacydraft1/versions/ver_legacy_two.html",
      contentHash: "sha256:two",
      fileSize: 12,
      filename: "legacy.html",
      metadata: { cliVersion: "test" },
      sourceIp: null,
      userAgent: "vitest"
    });
    expect(updated.versionNumber).toBe(2);
  });

  it("default-fills stored rows with the fields a later schema version adds", async () => {
    const filePath = path.join(tempDir, "db.json");
    await writeFile(filePath, `${JSON.stringify(deployedSchemaFixture(), null, 2)}\n`, "utf8");
    const reviewNoteMigration: SchemaMigration = {
      id: "9999_probe_drafts_review_note",
      json(state) {
        const drafts = state.drafts;
        if (!Array.isArray(drafts)) return;
        for (const draft of drafts) {
          if (draft && typeof draft === "object" && !("reviewNote" in draft)) {
            (draft as Record<string, unknown>).reviewNote = null;
          }
        }
      }
    };

    const upgraded = new JsonFilePatchPageDb(filePath, {
      migrations: [...SCHEMA_MIGRATIONS, reviewNoteMigration]
    });
    await upgraded.initialize(null);

    const stored = JSON.parse(await readFile(filePath, "utf8")) as {
      schemaMigrations: string[];
      drafts: Array<{ id: string; reviewNote: string | null }>;
    };
    expect(stored.schemaMigrations).toEqual([
      ...SCHEMA_MIGRATION_IDS,
      "9999_probe_drafts_review_note"
    ]);
    expect(stored.drafts).toEqual([
      expect.objectContaining({ id: "legacydraft1", reviewNote: null })
    ]);

    // The row guards accept the migrated shape, and a handle still running the
    // older schema keeps reading rows a newer one wrote.
    expect((await upgraded.findDraftVersion("legacydraft1")).draft?.title).toBe("Legacy draft");
    const older = new JsonFilePatchPageDb(filePath);
    expect((await older.findDraftVersion("legacydraft1")).draft?.title).toBe("Legacy draft");
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
          intent: "create",
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

  it.skipIf(process.platform === "win32")(
    "rejects a live symbolic-link parent without changing the link or target",
    async () => {
      const realParent = path.join(tempDir, "real-parent");
      const aliasedParent = path.join(tempDir, "aliased-parent");
      const realFilePath = path.join(realParent, "db.json");
      const aliasedFilePath = path.join(aliasedParent, "db.json");
      await mkdir(realParent);
      await new JsonFilePatchPageDb(realFilePath).initialize("original-secret");
      const original = await readFile(realFilePath);
      await symlink(realParent, aliasedParent, "dir");

      const error = await new JsonFilePatchPageDb(aliasedFilePath)
        .initialize("replacement-secret")
        .then(
          () => null,
          (reason: unknown) => reason
        );

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "JSON metadata file path must not have symbolic-link parent directories."
      );
      expect(String(error)).not.toContain("original-secret");
      expect(String(error)).not.toContain("replacement-secret");
      expect((await lstat(aliasedParent)).isSymbolicLink()).toBe(true);
      expect(await readlink(aliasedParent)).toBe(realParent);
      expect(await readFile(realFilePath)).toEqual(original);
    }
  );

  it.skipIf(process.platform === "win32")(
    "serializes modeled containing-directory bind aliases by shared identity",
    async () => {
      const realParent = path.join(tempDir, "identity-parent");
      const aliasedParent = path.join(tempDir, "identity-alias");
      await mkdir(realParent);
      await symlink(realParent, aliasedParent, "dir");

      const trackedLstat = (async (...args: Parameters<typeof fsPromises.lstat>) => {
        if (path.resolve(String(args[0])) === aliasedParent) {
          return fsPromises.stat(realParent);
        }
        return Reflect.apply(fsPromises.lstat, fsPromises, args);
      }) as typeof fsPromises.lstat;

      vi.resetModules();
      vi.doMock("node:fs/promises", () => ({
        ...fsPromises,
        lstat: trackedLstat
      }));

      const realFilePath = path.join(realParent, "db.json");
      const aliasedFilePath = path.join(aliasedParent, "db.json");
      try {
        // The lstat mock models a bind mount, which is not a symbolic-link parent.
        const { JsonFilePatchPageDb: IdentityJsonFilePatchPageDb } = await import(
          "./json-db.js"
        );
        const uploads = Array.from({ length: 8 }, (_, index) => {
          const draftId = `identity_draft_${index}`;
          const versionId = `identity_ver_${index}`;
          const db = new IdentityJsonFilePatchPageDb(
            index % 2 === 0 ? realFilePath : aliasedFilePath
          );
          return db.recordUpload({
            intent: "create",
            draftId,
            versionId,
            accountId: "acct_test",
            apiTokenId: "tok_test",
            title: `Identity draft ${index}`,
            objectKey: `drafts/${draftId}/versions/${versionId}.html`,
            contentHash: `sha256:identity-${index}`,
            fileSize: index + 1,
            filename: `identity-${index}.html`,
            metadata: { padding: "x".repeat(64 * 1024) },
            sourceIp: null,
            userAgent: "vitest"
          });
        });
        await Promise.all(uploads);
      } finally {
        vi.doUnmock("node:fs/promises");
        vi.resetModules();
      }

      const db = new JsonFilePatchPageDb(realFilePath);
      for (let index = 0; index < 8; index += 1) {
        const lookup = await db.findDraftVersion(`identity_draft_${index}`);
        expect(lookup.version?.id).toBe(`identity_ver_${index}`);
      }
    }
  );

  it.skipIf(process.platform === "win32")(
    "rejects a dangling parent alias already running before its target is created",
    async () => {
      const directoryPath = path.join(tempDir, "staggered-parent");
      const aliasedDirectoryPath = path.join(tempDir, "staggered-alias");
      await symlink(directoryPath, aliasedDirectoryPath, "dir");
      const filePath = path.join(directoryPath, "db.json");
      const aliasedFilePath = path.join(aliasedDirectoryPath, "db.json");

      let resolveMkdirStarted = (): void => undefined;
      const mkdirStarted = new Promise<void>((resolve) => {
        resolveMkdirStarted = resolve;
      });
      let releaseMkdir = (): void => undefined;
      const mkdirRelease = new Promise<void>((resolve) => {
        releaseMkdir = resolve;
      });
      const trackedMkdir = (async (...args: Parameters<typeof fsPromises.mkdir>) => {
        if (path.resolve(String(args[0])) === directoryPath) {
          resolveMkdirStarted();
          await mkdirRelease;
        }
        return Reflect.apply(fsPromises.mkdir, fsPromises, args);
      }) as typeof fsPromises.mkdir;

      vi.resetModules();
      vi.doMock("node:fs/promises", () => ({
        ...fsPromises,
        mkdir: trackedMkdir
      }));

      try {
        // A static import cannot observe the per-test mocked filesystem boundary.
        const { JsonFilePatchPageDb: StaggeredJsonFilePatchPageDb } = await import(
          "./json-db.js"
        );
        const firstDb = new StaggeredJsonFilePatchPageDb(filePath);
        const first = firstDb.recordUpload({
          intent: "create",
          draftId: "staggered_first",
          versionId: "staggered_ver_first",
          accountId: "acct_test",
          apiTokenId: "tok_test",
          title: "Staggered first",
          objectKey: "drafts/staggered-first/version.html",
          contentHash: "sha256:staggered-first",
          fileSize: 1,
          filename: "first.html",
          metadata: {},
          sourceIp: null,
          userAgent: "vitest"
        });
        await mkdirStarted;

        const secondError = await new StaggeredJsonFilePatchPageDb(aliasedFilePath)
          .recordUpload({
            intent: "create",
            draftId: "staggered_second",
            versionId: "staggered_ver_second",
            accountId: "acct_test",
            apiTokenId: "tok_test",
            title: "Staggered second",
            objectKey: "drafts/staggered-second/version.html",
            contentHash: "sha256:staggered-second",
            fileSize: 1,
            filename: "second.html",
            metadata: {},
            sourceIp: null,
            userAgent: "vitest"
          })
          .then(
            () => null,
            (reason: unknown) => reason
          );

        expect(secondError).toBeInstanceOf(Error);
        expect((secondError as Error).message).toBe(
          "JSON metadata file path must not have symbolic-link parent directories."
        );
        expect(String(secondError)).not.toContain("staggered_second");

        releaseMkdir();
        await first;
        expect((await firstDb.findDraftVersion("staggered_first")).version?.id).toBe(
          "staggered_ver_first"
        );
        expect((await firstDb.findDraftVersion("staggered_second")).version).toBeNull();
        expect((await lstat(aliasedDirectoryPath)).isSymbolicLink()).toBe(true);
      } finally {
        releaseMkdir();
        vi.doUnmock("node:fs/promises");
        vi.resetModules();
      }
    }
  );

  it("serializes fresh-file mutations through case aliases on case-insensitive filesystems", async () => {
    const parentPath = path.join(tempDir, "CaseParent");
    const parentAlias = path.join(tempDir, "caseparent");
    await mkdir(parentPath);

    const aliasesShareDirectory = await stat(parentAlias).then(
      (aliasStats) => stat(parentPath).then((parentStats) => aliasStats.ino === parentStats.ino),
      () => false
    );
    if (!aliasesShareDirectory) return;

    const upperFilePath = path.join(parentPath, "PatchPage.JSON");
    const lowerFilePath = path.join(parentAlias, "patchpage.json");
    const uploads = Array.from({ length: 12 }, (_, index) => {
      const draftId = `case_draft_${index}`;
      const versionId = `case_ver_${index}`;
      const db = new JsonFilePatchPageDb(index % 2 === 0 ? upperFilePath : lowerFilePath);

      return db.recordUpload({
        intent: "create",
        draftId,
        versionId,
        accountId: "acct_test",
        apiTokenId: "tok_test",
        title: `Case draft ${index}`,
        objectKey: `drafts/${draftId}/versions/${versionId}.html`,
        contentHash: `sha256:case-${index}`,
        fileSize: index + 1,
        filename: `case-${index}.html`,
        metadata: { padding: "x".repeat(64 * 1024) },
        sourceIp: null,
        userAgent: "vitest"
      });
    });

    await Promise.all(uploads);

    const db = new JsonFilePatchPageDb(upperFilePath);
    for (let index = 0; index < uploads.length; index += 1) {
      const lookup = await db.findDraftVersion(`case_draft_${index}`);
      expect(lookup.version?.id).toBe(`case_ver_${index}`);
    }
  });

  it("serializes fresh-file mutations through Unicode case aliases when the filesystem supports them", async () => {
    const parentPath = path.join(tempDir, "unicode-case-parent");
    await mkdir(parentPath);
    const probePath = path.join(parentPath, "Straße.probe");
    const probeAlias = path.join(parentPath, "STRASSE.probe");
    await writeFile(probePath, "probe");
    const aliasesShareFile = await stat(probeAlias).then(
      (aliasStats) => stat(probePath).then((probeStats) => aliasStats.ino === probeStats.ino),
      () => false
    );
    await rm(probePath);
    if (!aliasesShareFile) return;

    const mixedCaseFilePath = path.join(parentPath, "Straße.JSON");
    const foldedFilePath = path.join(parentPath, "STRASSE.json");
    const uploads = Array.from({ length: 8 }, (_, index) => {
      const draftId = `unicode_case_draft_${index}`;
      const versionId = `unicode_case_ver_${index}`;
      const db = new JsonFilePatchPageDb(
        index % 2 === 0 ? mixedCaseFilePath : foldedFilePath
      );

      return db.recordUpload({
        intent: "create",
        draftId,
        versionId,
        accountId: "acct_test",
        apiTokenId: "tok_test",
        title: `Unicode case draft ${index}`,
        objectKey: `drafts/${draftId}/versions/${versionId}.html`,
        contentHash: `sha256:unicode-case-${index}`,
        fileSize: index + 1,
        filename: `unicode-case-${index}.html`,
        metadata: { padding: "x".repeat(64 * 1024) },
        sourceIp: null,
        userAgent: "vitest"
      });
    });

    await Promise.all(uploads);

    const db = new JsonFilePatchPageDb(mixedCaseFilePath);
    for (let index = 0; index < uploads.length; index += 1) {
      const lookup = await db.findDraftVersion(`unicode_case_draft_${index}`);
      expect(lookup.version?.id).toBe(`unicode_case_ver_${index}`);
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
        intent: "create",
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

  it.skipIf(process.platform === "win32")(
    "rejects a live final-component database symlink without changing it or its target",
    async () => {
      const targetPath = path.join(tempDir, "target.json");
      const filePath = path.join(tempDir, "db.json");
      await new JsonFilePatchPageDb(targetPath).initialize("target-secret");
      const originalTarget = await readFile(targetPath);
      await symlink(path.basename(targetPath), filePath);
      const originalLink = await lstat(filePath);
      const originalLinkTarget = await readlink(filePath);

      const error = await new JsonFilePatchPageDb(filePath)
        .initialize("replacement-secret")
        .then(
          () => null,
          (reason: unknown) => reason
        );

      const finalLink = await lstat(filePath);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "JSON metadata file path must not be a symbolic link."
      );
      expect(String(error)).not.toContain("target-secret");
      expect(String(error)).not.toContain("replacement-secret");
      expect(finalLink.isSymbolicLink()).toBe(true);
      expect(finalLink.ino).toBe(originalLink.ino);
      expect(await readlink(filePath)).toBe(originalLinkTarget);
      expect(await readFile(targetPath)).toEqual(originalTarget);
      expect((await readdir(tempDir)).sort()).toEqual(["db.json", "target.json"]);
    }
  );

  it.skipIf(process.platform === "win32")(
    "rejects a dangling final-component database symlink without replacing it",
    async () => {
      const targetPath = path.join(tempDir, "missing-target.json");
      const filePath = path.join(tempDir, "db.json");
      await symlink(path.basename(targetPath), filePath);
      const originalLink = await lstat(filePath);
      const originalLinkTarget = await readlink(filePath);

      const error = await new JsonFilePatchPageDb(filePath)
        .initialize("replacement-secret")
        .then(
          () => null,
          (reason: unknown) => reason
        );

      const finalLink = await lstat(filePath);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "JSON metadata file path must not be a symbolic link."
      );
      expect(String(error)).not.toContain("replacement-secret");
      expect(finalLink.isSymbolicLink()).toBe(true);
      expect(finalLink.ino).toBe(originalLink.ino);
      expect(await readlink(filePath)).toBe(originalLinkTarget);
      await expect(lstat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(tempDir)).toEqual(["db.json"]);
    }
  );

  it.skipIf(process.platform === "win32")(
    "rejects a hard-linked database file without changing either alias",
    async () => {
      const filePath = path.join(tempDir, "db.json");
      const aliasPath = path.join(tempDir, "db-alias.json");
      await new JsonFilePatchPageDb(filePath).initialize("original-secret");
      await link(filePath, aliasPath);
      const original = await readFile(filePath);
      const originalStats = await lstat(filePath);

      const error = await new JsonFilePatchPageDb(aliasPath)
        .initialize("replacement-secret")
        .then(
          () => null,
          (reason: unknown) => reason
        );

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "JSON metadata file path must not have multiple hard links."
      );
      expect(String(error)).not.toContain("original-secret");
      expect(String(error)).not.toContain("replacement-secret");
      expect(await readFile(filePath)).toEqual(original);
      expect(await readFile(aliasPath)).toEqual(original);
      expect((await lstat(filePath)).ino).toBe(originalStats.ino);
      expect((await lstat(aliasPath)).ino).toBe(originalStats.ino);
      expect((await readdir(tempDir)).sort()).toEqual(["db-alias.json", "db.json"]);
    }
  );

  it.skipIf(process.platform === "win32")(
    "rejects a non-regular database file without modifying it",
    async () => {
      const filePath = path.join(tempDir, "db.json");
      await execFile("mkfifo", [filePath]);
      const originalStats = await lstat(filePath);

      const error = await new JsonFilePatchPageDb(filePath)
        .initialize("replacement-secret")
        .then(
          () => null,
          (reason: unknown) => reason
        );

      const finalStats = await lstat(filePath);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "JSON metadata file path must be a regular file."
      );
      expect(String(error)).not.toContain("replacement-secret");
      expect(finalStats.isFIFO()).toBe(true);
      expect(finalStats.ino).toBe(originalStats.ino);
      expect(await readdir(tempDir)).toEqual(["db.json"]);
    }
  );

  it("rejects mutation state that cannot survive JSON persistence losslessly", async () => {
    const filePath = path.join(tempDir, "db.json");
    const db = new JsonFilePatchPageDb(filePath);
    await db.initialize("dev-token");
    const auth = await db.findApiTokenByToken("dev-token");
    expect(auth).not.toBeNull();
    const original = await readFile(filePath);

    const cyclicValue: Record<string, unknown> = { secret: "mutation-secret" };
    cyclicValue.self = cyclicValue;
    const sparseValue = new Array(1);
    let toJsonCalls = 0;
    const transformingValue = {
      secret: "mutation-secret",
      toJSON() {
        toJsonCalls += 1;
        return { transformed: true };
      }
    };
    const accessorValue = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        throw new Error("mutation-secret");
      }
    });
    const hiddenValue = Object.defineProperty({}, "secret", {
      enumerable: false,
      value: "mutation-secret"
    });
    const symbolKeyValue = { safe: true } as Record<PropertyKey, unknown>;
    symbolKeyValue[Symbol("mutation-secret")] = true;
    const sharedChild = { secret: "mutation-secret" };
    const sharedReferenceValue = { first: sharedChild, second: sharedChild };
    const nullPrototypeValue = Object.assign(Object.create(null), { safe: true });
    let proxyTrapCalls = 0;
    const proxyPrototype = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          proxyTrapCalls += 1;
          throw new Error("mutation-secret");
        },
        getPrototypeOf() {
          proxyTrapCalls += 1;
          throw new Error("mutation-secret");
        }
      }
    );
    const inheritedProxyValue = Object.create(proxyPrototype) as Record<string, unknown>;

    const hazards: Array<{ name: string; value: unknown }> = [
      { name: "NaN", value: Number.NaN },
      { name: "positive infinity", value: Number.POSITIVE_INFINITY },
      { name: "negative infinity", value: Number.NEGATIVE_INFINITY },
      { name: "negative zero", value: -0 },
      { name: "undefined", value: undefined },
      { name: "function", value: () => "mutation-secret" },
      { name: "symbol", value: Symbol("mutation-secret") },
      { name: "bigint", value: 1n },
      { name: "transforming toJSON", value: transformingValue },
      { name: "cycle", value: cyclicValue },
      { name: "sparse array", value: sparseValue },
      { name: "accessor", value: accessorValue },
      { name: "non-enumerable state", value: hiddenValue },
      { name: "symbol-keyed state", value: symbolKeyValue },
      { name: "shared object reference", value: sharedReferenceValue },
      { name: "null-prototype object", value: nullPrototypeValue },
      { name: "exotic object", value: new Date() },
      { name: "proxy prototype", value: inheritedProxyValue }
    ];

    for (const hazard of hazards) {
      const error = await db
        .recordUpload({
          intent: "create",
          draftId: `unsafe_${hazard.name}`,
          versionId: `ver_${hazard.name}`,
          accountId: auth!.accountId,
          apiTokenId: auth!.id,
          title: "Unsafe mutation",
          objectKey: "drafts/unsafe/version.html",
          contentHash: "sha256:unsafe",
          fileSize: 1,
          filename: "unsafe.html",
          metadata: { secret: "mutation-secret", hazard: hazard.value },
          sourceIp: null,
          userAgent: "vitest"
        })
        .then(
          () => null,
          (reason: unknown) => reason
        );

      expect(error, hazard.name).toBeInstanceOf(Error);
      expect((error as Error).message, hazard.name).toBe(
        "JSON metadata state cannot be persisted losslessly."
      );
      expect(String(error), hazard.name).not.toContain("mutation-secret");
      expect(String(error), hazard.name).not.toContain("dev-token");
      expect(await readFile(filePath), hazard.name).toEqual(original);
      expect(await readdir(tempDir), hazard.name).toEqual(["db.json"]);
    }

    expect(toJsonCalls).toBe(0);
    expect(proxyTrapCalls).toBe(0);
  });

  it("rejects unsafe metadata accessors without invoking or disclosing them", async () => {
    const filePath = path.join(tempDir, "db.json");
    const db = new JsonFilePatchPageDb(filePath);
    await db.initialize("dev-token");
    const original = await readFile(filePath);
    let accessorCalls = 0;
    const metadata = Object.defineProperty({}, "repoOrg", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        throw new Error("mutation-secret");
      }
    });

    const error = await db
      .recordUpload({
        intent: "create",
        draftId: "unsafe_accessor",
        versionId: "ver_unsafe_accessor",
        accountId: "acct_bootstrap",
        apiTokenId: "tok_bootstrap",
        title: "Unsafe accessor",
        objectKey: "drafts/unsafe-accessor/version.html",
        contentHash: "sha256:unsafe-accessor",
        fileSize: 1,
        filename: "unsafe.html",
        metadata,
        sourceIp: null,
        userAgent: "vitest"
      })
      .then(
        () => null,
        (reason: unknown) => reason
      );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "JSON metadata state cannot be persisted losslessly."
    );
    expect(String(error)).not.toContain("mutation-secret");
    expect(accessorCalls).toBe(0);
    expect(await readFile(filePath)).toEqual(original);
    expect(await readdir(tempDir)).toEqual(["db.json"]);
  });

  it("rejects unsafe token mutation state without disclosing the raw token", async () => {
    const filePath = path.join(tempDir, "db.json");
    const db = new JsonFilePatchPageDb(filePath);
    await db.initialize("dev-token");
    const original = await readFile(filePath);

    const error = await db
      .createApiToken({
        accountId: "acct_bootstrap",
        name: "Unsafe token",
        token: "raw-token-secret",
        scopes: ["upload", undefined] as unknown as string[]
      })
      .then(
        () => null,
        (reason: unknown) => reason
      );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "JSON metadata state cannot be persisted losslessly."
    );
    expect(String(error)).not.toContain("raw-token-secret");
    expect(await readFile(filePath)).toEqual(original);
    expect(await readdir(tempDir)).toEqual(["db.json"]);
  });

  it("rejects unsafe state before opening a temporary commit file", async () => {
    const filePath = path.join(tempDir, "db.json");
    await new JsonFilePatchPageDb(filePath).initialize("dev-token");
    const original = await readFile(filePath);
    const actualFs = fsPromises;
    const temporaryOpens: string[] = [];
    const trackedOpen = (async (...args: Parameters<typeof actualFs.open>) => {
      if (args[1] === "wx") temporaryOpens.push(String(args[0]));
      return Reflect.apply(actualFs.open, actualFs, args);
    }) as typeof actualFs.open;

    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({ ...actualFs, open: trackedOpen }));

    let error: unknown;
    try {
      // A static import cannot observe the per-test mocked filesystem boundary.
      const { JsonFilePatchPageDb: TrackedJsonFilePatchPageDb } = await import(
        "./json-db.js"
      );
      error = await new TrackedJsonFilePatchPageDb(filePath)
        .recordUpload({
          intent: "create",
          draftId: "unsafe_before_temp",
          versionId: "ver_unsafe_before_temp",
          accountId: "acct_bootstrap",
          apiTokenId: "tok_bootstrap",
          title: "Unsafe before temp",
          objectKey: "drafts/unsafe-before-temp/version.html",
          contentHash: "sha256:unsafe-before-temp",
          fileSize: 1,
          filename: "unsafe.html",
          metadata: { secret: "mutation-secret", unsafe: 1n },
          sourceIp: null,
          userAgent: "vitest"
        })
        .then(
          () => null,
          (reason: unknown) => reason
        );
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "JSON metadata state cannot be persisted losslessly."
    );
    expect(String(error)).not.toContain("mutation-secret");
    expect(temporaryOpens).toEqual([]);
    expect(await readFile(filePath)).toEqual(original);
  });

  it.skipIf(process.platform === "win32")(
    "flushes each new parent directory entry during fresh initialization",
    async () => {
      const actualFs = fsPromises;
      const syncedDirectories: string[] = [];
      const trackedOpen = (async (...args: Parameters<typeof actualFs.open>) => {
        const handle = await Reflect.apply(actualFs.open, actualFs, args);
        if (args[1] === "r") {
          const directoryPath = path.resolve(String(args[0]));
          const originalSync = handle.sync.bind(handle);
          handle.sync = async () => {
            syncedDirectories.push(directoryPath);
            await originalSync();
          };
        }
        return handle;
      }) as typeof actualFs.open;

      vi.resetModules();
      vi.doMock("node:fs/promises", () => ({ ...actualFs, open: trackedOpen }));

      const directoryPath = path.join(tempDir, "first", "second");
      const filePath = path.join(directoryPath, "db.json");
      try {
        // A static import cannot observe the per-test mocked filesystem boundary.
        const { JsonFilePatchPageDb: TrackedJsonFilePatchPageDb } = await import(
          "./json-db.js"
        );
        await new TrackedJsonFilePatchPageDb(filePath).initialize("dev-token");
      } finally {
        vi.doUnmock("node:fs/promises");
        vi.resetModules();
      }

      expect(syncedDirectories).toEqual(
        expect.arrayContaining([
          tempDir,
          path.join(tempDir, "first"),
          directoryPath
        ])
      );
      const auth = await new JsonFilePatchPageDb(filePath).findApiTokenByToken(
        "dev-token"
      );
      expect(auth?.id).toBe("tok_bootstrap");
    }
  );
  it.skipIf(process.platform === "win32")(
    "retries parent durability after a new-directory fsync failure",
    async () => {
      let failParentSync = true;
      const failingOpen = (async (...args: Parameters<typeof fsPromises.open>) => {
        const handle = await Reflect.apply(fsPromises.open, fsPromises, args);
        if (args[1] === "r" && path.resolve(String(args[0])) === tempDir) {
          const originalSync = handle.sync.bind(handle);
          handle.sync = async () => {
            if (failParentSync) {
              failParentSync = false;
              throw Object.assign(new Error("parent sync failed"), { code: "EIO" });
            }
            await originalSync();
          };
        }
        return handle;
      }) as typeof fsPromises.open;

      vi.resetModules();
      vi.doMock("node:fs/promises", () => ({ ...fsPromises, open: failingOpen }));

      const directoryPath = path.join(tempDir, "first", "second");
      const filePath = path.join(directoryPath, "db.json");
      let error: unknown;
      try {
        // A static import cannot observe the per-test mocked filesystem boundary.
        const { JsonFilePatchPageDb: FailingJsonFilePatchPageDb } = await import(
          "./json-db.js"
        );
        error = await new FailingJsonFilePatchPageDb(filePath)
          .initialize("dev-token")
          .then(
            () => null,
            (reason: unknown) => reason
          );
      } finally {
        vi.doUnmock("node:fs/promises");
        vi.resetModules();
      }

      expect(error).toMatchObject({ code: "EIO" });
      expect((await lstat(path.join(tempDir, "first"))).isDirectory()).toBe(true);

      let retriedParentSyncs = 0;
      const trackedRetryOpen = (async (...args: Parameters<typeof fsPromises.open>) => {
        const handle = await Reflect.apply(fsPromises.open, fsPromises, args);
        if (args[1] === "r" && path.resolve(String(args[0])) === tempDir) {
          const originalSync = handle.sync.bind(handle);
          handle.sync = async () => {
            retriedParentSyncs += 1;
            await originalSync();
          };
        }
        return handle;
      }) as typeof fsPromises.open;

      vi.resetModules();
      vi.doMock("node:fs/promises", () => ({
        ...fsPromises,
        open: trackedRetryOpen
      }));

      try {
        // A static import cannot observe the per-test mocked filesystem boundary.
        const { JsonFilePatchPageDb: RetryingJsonFilePatchPageDb } = await import(
          "./json-db.js"
        );
        const db = new RetryingJsonFilePatchPageDb(filePath);
        await db.initialize("dev-token");
        expect((await db.findApiTokenByToken("dev-token"))?.id).toBe("tok_bootstrap");
      } finally {
        vi.doUnmock("node:fs/promises");
        vi.resetModules();
      }

      expect(retriedParentSyncs).toBeGreaterThan(0);
    }
  );


  it("fails before commit when the target directory cannot be opened", async () => {
    const filePath = path.join(tempDir, "db.json");
    const db = new JsonFilePatchPageDb(filePath);
    await db.initialize("dev-token");
    const original = await readFile(filePath);
    const actualFs = fsPromises;
    const failingOpen = (async (...args: Parameters<typeof actualFs.open>) => {
      if (args[1] === "r" && path.resolve(String(args[0])) === tempDir) {
        throw Object.assign(new Error("directory open failed"), { code: "EACCES" });
      }
      return Reflect.apply(actualFs.open, actualFs, args);
    }) as typeof actualFs.open;

    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({ ...actualFs, open: failingOpen }));

    let error: unknown;
    try {
      // A static import cannot observe the per-test mocked filesystem boundary.
      const { JsonFilePatchPageDb: FailingJsonFilePatchPageDb } = await import(
        "./json-db.js"
      );
      error = await new FailingJsonFilePatchPageDb(filePath)
        .initialize("replacement-secret")
        .then(
          () => null,
          (reason: unknown) => reason
        );
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: "EACCES" });
    expect(String(error)).not.toContain("replacement-secret");
    expect(await readFile(filePath)).toEqual(original);
    expect(await readdir(tempDir)).toEqual(["db.json"]);
    expect(await db.findApiTokenByToken("replacement-secret")).toBeNull();
  });

  it.skipIf(process.platform === "win32")(
    "reuses the precommit target directory handle after rename",
    async () => {
      const filePath = path.join(tempDir, "db.json");
      await new JsonFilePatchPageDb(filePath).initialize("dev-token");
      const actualFs = fsPromises;
      let targetDirectoryOpens = 0;
      let targetDirectorySyncs = 0;
      const singleDirectoryOpen = (async (...args: Parameters<typeof actualFs.open>) => {
        const isTargetDirectory =
          args[1] === "r" && path.resolve(String(args[0])) === tempDir;
        if (isTargetDirectory && targetDirectoryOpens > 0) {
          throw Object.assign(new Error("target directory reopened"), {
            code: "EACCES"
          });
        }

        const handle = await Reflect.apply(actualFs.open, actualFs, args);
        if (isTargetDirectory) {
          targetDirectoryOpens += 1;
          const originalSync = handle.sync.bind(handle);
          handle.sync = async () => {
            targetDirectorySyncs += 1;
            await originalSync();
          };
        }
        return handle;
      }) as typeof actualFs.open;

      vi.resetModules();
      vi.doMock("node:fs/promises", () => ({
        ...actualFs,
        open: singleDirectoryOpen
      }));

      try {
        // A static import cannot observe the per-test mocked filesystem boundary.
        const { JsonFilePatchPageDb: SingleOpenJsonFilePatchPageDb } = await import(
          "./json-db.js"
        );
        await new SingleOpenJsonFilePatchPageDb(filePath).initialize(
          "replacement-secret"
        );
      } finally {
        vi.doUnmock("node:fs/promises");
        vi.resetModules();
      }

      expect(targetDirectoryOpens).toBe(1);
      expect(targetDirectorySyncs).toBe(1);
      expect(await readdir(tempDir)).toEqual(["db.json"]);
      const auth = await new JsonFilePatchPageDb(filePath).findApiTokenByToken(
        "replacement-secret"
      );
      expect(auth?.id).toBe("tok_bootstrap");
    }
  );

  it("reports an indeterminate outcome when directory fsync fails after rename", async () => {
    const filePath = path.join(tempDir, "db.json");
    await new JsonFilePatchPageDb(filePath).initialize("dev-token");
    const original = await readFile(filePath);
    const actualFs = fsPromises;
    const failingOpen = (async (...args: Parameters<typeof actualFs.open>) => {
      const handle = await Reflect.apply(actualFs.open, actualFs, args);
      if (args[1] === "r" && path.resolve(String(args[0])) === tempDir) {
        handle.sync = async () => {
          throw Object.assign(new Error("filesystem-secret"), { code: "EIO" });
        };
      }
      return handle;
    }) as typeof actualFs.open;

    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({ ...actualFs, open: failingOpen }));

    let error: unknown;
    try {
      // A static import cannot observe the per-test mocked filesystem boundary.
      const { JsonFilePatchPageDb: FailingJsonFilePatchPageDb } = await import(
        "./json-db.js"
      );
      error = await new FailingJsonFilePatchPageDb(filePath)
        .initialize("replacement-secret")
        .then(
          () => null,
          (reason: unknown) => reason
        );
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("commit outcome is indeterminate");
    expect(String(error)).not.toContain("filesystem-secret");
    expect(String(error)).not.toContain("replacement-secret");
    expect(await readFile(filePath)).not.toEqual(original);
    expect(await readdir(tempDir)).toEqual(["db.json"]);
    const auth = await new JsonFilePatchPageDb(filePath).findApiTokenByToken(
      "replacement-secret"
    );
    expect(auth?.id).toBe("tok_bootstrap");
  });

  it("rejects Linux single-file mounts without changing the mounted file", async () => {
    const filePath = path.join(tempDir, "db.json");
    await new JsonFilePatchPageDb(filePath).initialize("dev-token");
    const original = await readFile(filePath);
    const actualFs = fsPromises;
    const busyRename = (async () => {
      throw Object.assign(new Error("mount-secret"), { code: "EBUSY" });
    }) as typeof actualFs.rename;
    const followedRootLstat = (async (...args: Parameters<typeof actualFs.lstat>) => {
      const requestedPath = path.resolve(String(args[0]));
      if (requestedPath === "/etc" || requestedPath === "/tmp" || requestedPath === "/var") {
        return actualFs.stat(requestedPath);
      }
      return Reflect.apply(actualFs.lstat, actualFs, args);
    }) as typeof actualFs.lstat;
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({
      ...actualFs,
      lstat: followedRootLstat,
      rename: busyRename
    }));
    Object.defineProperty(process, "platform", {
      ...originalPlatform,
      value: "linux"
    });

    let error: unknown;
    try {
      // A static import cannot observe the per-test mocked filesystem boundary.
      const { JsonFilePatchPageDb: MountedJsonFilePatchPageDb } = await import(
        "./json-db.js"
      );
      error = await new MountedJsonFilePatchPageDb(filePath)
        .initialize("replacement-secret")
        .then(
          () => null,
          (reason: unknown) => reason
        );
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
      if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "JSON metadata file cannot be a Linux single-file bind mount; mount a writable containing directory instead."
    );
    expect(String(error)).not.toContain("mount-secret");
    expect(String(error)).not.toContain("replacement-secret");
    expect(await readFile(filePath)).toEqual(original);
    expect(await readdir(tempDir)).toEqual(["db.json"]);
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
      intent: "create",
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
    let openSnapshot: string;
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
        intent: "create",
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
