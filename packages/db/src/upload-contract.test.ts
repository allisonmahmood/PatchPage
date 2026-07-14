import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { newDraftId, newInternalId, randomToken } from "@patchpage/core";
import { JsonFilePatchPageDb } from "./json-db.js";
import { PostgresPatchPageDb } from "./postgres-db.js";
import { isUploadTargetError } from "./types.js";
import type {
  ApiTokenAuth,
  PatchPageDb,
  RecordUploadInput,
  RecordUploadResult
} from "./types.js";

type UploadIntent = "create" | "update";
type IntendedRecordUploadInput = RecordUploadInput & { intent: UploadIntent };

interface ContractHarness {
  db: PatchPageDb;
  peerDb: PatchPageDb;
  auth: ApiTokenAuth;
  close(): Promise<void>;
}

type ContractHarnessFactory = () => Promise<ContractHarness>;

function describeUploadContract(
  driverName: string,
  createHarness: ContractHarnessFactory,
  enabled = true
): void {
  const suite = enabled ? describe : describe.skip;

  suite(`${driverName} draft upload contract`, () => {
    it("initializes a non-authenticating anonymous upload principal idempotently", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();

      try {
        await harness.db.initialize(null);
        await harness.db.initialize(null);
        const principal = await harness.db.getAnonymousUploadPrincipal();

        expect(principal).toEqual({
          accountId: "acct_anonymous",
          apiTokenId: "tok_anonymous"
        });
        for (const unusableCredential of [
          principal.apiTokenId,
          principal.accountId,
          "anonymous"
        ]) {
          await expect(
            harness.db.findApiTokenByToken(unusableCredential)
          ).resolves.toBeNull();
        }

        await harness.db.recordUpload(
          uploadInput("create", draftId, harness.auth, {
            accountId: principal.accountId,
            apiTokenId: principal.apiTokenId
          })
        );
        const lookup = await harness.db.findDraftVersion(draftId);
        expect(lookup.draft?.accountId).toBe(principal.accountId);
        expect(lookup.version?.createdByApiTokenId).toBe(principal.apiTokenId);
      } finally {
        await harness.close();
      }
    });

    it("allows only explicitly authorized moderation of anonymous drafts", async () => {
      const harness = await createHarness();
      const principal = await harness.db.getAnonymousUploadPrincipal();
      const disabledDraftId = newDraftId();
      const deletedDraftId = newDraftId();

      try {
        for (const draftId of [disabledDraftId, deletedDraftId]) {
          await harness.db.recordUpload(
            uploadInput("create", draftId, harness.auth, {
              accountId: principal.accountId,
              apiTokenId: principal.apiTokenId
            })
          );
        }

        await expect(
          harness.db.disableDraft(
            disabledDraftId,
            harness.auth.accountId,
            "ordinary token"
          )
        ).resolves.toBe(false);
        await expect(
          harness.db.deleteDraft(deletedDraftId, harness.auth.accountId)
        ).resolves.toBe(false);

        await expect(
          harness.db.disableDraft(
            disabledDraftId,
            harness.auth.accountId,
            "admin policy",
            { canModerateAnonymous: true }
          )
        ).resolves.toBe(true);
        await expect(
          harness.db.deleteDraft(deletedDraftId, harness.auth.accountId, {
            canModerateAnonymous: true
          })
        ).resolves.toBe(true);
      } finally {
        await harness.close();
      }
    });

    it("rejects an update for an unknown draft without creating it", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();

      try {
        await expect(
          harness.db.assertUploadTarget(uploadInput("update", draftId, harness.auth))
        ).rejects.toMatchObject({
          message: "Draft not found.",
          statusCode: 404
        });

        await expect(
          harness.db.recordUpload(uploadInput("update", draftId, harness.auth))
        ).rejects.toMatchObject({
          message: "Draft not found.",
          statusCode: 404
        });

        expect(await harness.db.findDraftVersion(draftId)).toEqual({
          draft: null,
          version: null
        });

        const created = await harness.db.recordUpload(uploadInput("create", draftId, harness.auth));
        expect(created.versionNumber).toBe(1);
      } finally {
        await harness.close();
      }
    });

    it("adds a new version when the owning account updates an active draft", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();
      const createInput = uploadInput("create", draftId, harness.auth, {
        title: "Original title"
      });
      const updateInput = uploadInput("update", draftId, harness.auth, {
        title: "Updated title"
      });

      try {
        const created = await harness.db.recordUpload(createInput);
        const updated = await harness.db.recordUpload(updateInput);

        expect(created.versionNumber).toBe(1);
        expect(updated).toMatchObject({
          draftId,
          versionId: updateInput.versionId,
          versionNumber: 2,
          title: "Updated title"
        });

        const current = await harness.db.findDraftVersion(draftId);
        const original = await harness.db.findDraftVersion(draftId, 1);
        expect(current.draft?.accountId).toBe(harness.auth.accountId);
        expect(current.draft?.title).toBe("Updated title");
        expect(current.version?.id).toBe(updateInput.versionId);
        expect(original.version?.id).toBe(createInput.versionId);
      } finally {
        await harness.close();
      }
    });

    it("atomically rechecks ownership and status after preflight", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();
      const updateInput = uploadInput("update", draftId, harness.auth);

      try {
        await harness.db.recordUpload(uploadInput("create", draftId, harness.auth));
        await expect(harness.db.assertUploadTarget(updateInput)).resolves.toBeUndefined();
        await harness.db.disableDraft(draftId, harness.auth.accountId, "policy race");

        await expect(harness.db.recordUpload(updateInput)).rejects.toMatchObject({
          message: "Draft not found.",
          statusCode: 404
        });
      } finally {
        await harness.close();
      }
    });


    it("rejects unknown, foreign, deleted, and disabled update targets identically", async () => {
      const harness = await createHarness();
      const unknownDraftId = newDraftId();
      const foreignDraftId = newDraftId();
      const deletedDraftId = newDraftId();
      const disabledDraftId = newDraftId();

      try {
        for (const draftId of [foreignDraftId, deletedDraftId, disabledDraftId]) {
          await harness.db.recordUpload(uploadInput("create", draftId, harness.auth));
        }
        await harness.db.deleteDraft(deletedDraftId, harness.auth.accountId);
        await harness.db.disableDraft(disabledDraftId, harness.auth.accountId, "policy");

        const errors = await Promise.all([
          captureError(
            harness.db.recordUpload(uploadInput("update", unknownDraftId, harness.auth))
          ),
          captureError(
            harness.db.recordUpload(
              uploadInput("update", foreignDraftId, harness.auth, {
                accountId: "acct_another"
              })
            )
          ),
          captureError(
            harness.db.recordUpload(uploadInput("update", deletedDraftId, harness.auth))
          ),
          captureError(
            harness.db.recordUpload(uploadInput("update", disabledDraftId, harness.auth))
          )
        ]);

        for (const error of errors) {
          expect(error).toMatchObject({
            message: "Draft not found.",
            statusCode: 404
          });
        }
        expect(errors.map(String)).toEqual(Array(4).fill("Error: Draft not found."));
        for (const draftId of [
          unknownDraftId,
          foreignDraftId,
          deletedDraftId,
          disabledDraftId
        ]) {
          expect(errors.map(String).join("\n")).not.toContain(draftId);
        }
      } finally {
        await harness.close();
      }
    });

    it("allows only one concurrent create for the same server-generated ID", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();
      const firstInput = uploadInput("create", draftId, harness.auth);
      const secondInput = uploadInput("create", draftId, harness.auth);

      try {
        const outcomes = await Promise.allSettled([
          harness.db.recordUpload(firstInput),
          harness.peerDb.recordUpload(secondInput)
        ]);
        const fulfilled = outcomes.filter(
          (outcome): outcome is PromiseFulfilledResult<RecordUploadResult> =>
            outcome.status === "fulfilled"
        );
        const rejected = outcomes.filter(
          (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected"
        );

        expect(fulfilled).toHaveLength(1);
        expect(fulfilled[0]?.value.versionNumber).toBe(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0]?.reason).toMatchObject({
          message: "Draft already exists.",
          statusCode: 409
        });

        const current = await harness.db.findDraftVersion(draftId);
        const unexpectedSecondVersion = await harness.db.findDraftVersion(draftId, 2);
        expect([firstInput.versionId, secondInput.versionId]).toContain(current.version?.id);
        expect(unexpectedSecondVersion.version).toBeNull();
      } finally {
        await harness.close();
      }
    });

    it("serializes concurrent owned updates into distinct sequential versions", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();
      const firstUpdate = uploadInput("update", draftId, harness.auth);
      const secondUpdate = uploadInput("update", draftId, harness.auth);

      try {
        await harness.db.recordUpload(uploadInput("create", draftId, harness.auth));

        const updates = await Promise.all([
          harness.db.recordUpload(firstUpdate),
          harness.peerDb.recordUpload(secondUpdate)
        ]);

        expect(updates.map((update) => update.versionNumber).sort()).toEqual([2, 3]);
        const secondVersion = await harness.db.findDraftVersion(draftId, 2);
        const thirdVersion = await harness.db.findDraftVersion(draftId, 3);
        expect([secondVersion.version?.id, thirdVersion.version?.id].sort()).toEqual(
          [firstUpdate.versionId, secondUpdate.versionId].sort()
        );
      } finally {
        await harness.close();
      }
    });

  });
}

describeUploadContract("JSON", createJsonHarness);

const postgresTestUrl = process.env.PATCHPAGE_TEST_DATABASE_URL;
const requirePostgresTests = process.env.PATCHPAGE_REQUIRE_POSTGRES_TESTS === "1";
if (requirePostgresTests && !postgresTestUrl) {
  throw new Error(
    "PATCHPAGE_REQUIRE_POSTGRES_TESTS=1 requires PATCHPAGE_TEST_DATABASE_URL."
  );
}
describeUploadContract(
  "Postgres",
  () => createPostgresHarness(postgresTestUrl!),
  Boolean(postgresTestUrl)
);

const postgresSuite = postgresTestUrl ? describe : describe.skip;
postgresSuite("Postgres rollback error handling", () => {
  it("preserves a typed final rejection when rollback also fails", async () => {
    const harness = await createPostgresHarness(postgresTestUrl!);
    const db = harness.db as PostgresPatchPageDb;
    const draftId = newDraftId();
    const updateInput = uploadInput("update", draftId, harness.auth);

    try {
      await db.recordUpload(uploadInput("create", draftId, harness.auth));
      await db.assertUploadTarget(updateInput);
      await db.disableDraft(draftId, harness.auth.accountId, "policy race");
      failRollbackAfterExecution(db);

      const error = await captureError(db.recordUpload(updateInput));
      expect(isUploadTargetError(error)).toBe(true);
      expect(error).toMatchObject({
        code: "draft_unavailable",
        message: "Draft not found.",
        statusCode: 404
      });
    } finally {
      await harness.close();
    }
  });
});

async function createJsonHarness(): Promise<ContractHarness> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "patchpage-upload-contract-"));
  const filePath = path.join(tempDir, "db.json");
  const db = new JsonFilePatchPageDb(filePath);
  const peerDb = new JsonFilePatchPageDb(filePath);
  const token = randomToken();
  await db.initialize(token);
  const auth = await db.findApiTokenByToken(token);
  if (!auth) throw new Error("Expected bootstrap authentication.");

  return {
    db,
    peerDb,
    auth,
    async close() {
      await Promise.all([db.close(), peerDb.close()]);
      await rm(tempDir, { recursive: true, force: true });
    }
  };
}

async function createPostgresHarness(connectionString: string): Promise<ContractHarness> {
  const db = new PostgresPatchPageDb(connectionString);
  const peerDb = new PostgresPatchPageDb(connectionString);
  const token = randomToken();
  await db.initialize(token);
  const auth = await db.findApiTokenByToken(token);
  if (!auth) throw new Error("Expected bootstrap authentication.");

  return {
    db,
    peerDb,
    auth,
    async close() {
      await Promise.all([db.close(), peerDb.close()]);
    }
  };
}

function uploadInput(
  intent: UploadIntent,
  draftId: string,
  auth: ApiTokenAuth,
  overrides: Partial<IntendedRecordUploadInput> = {}
): IntendedRecordUploadInput {
  const versionId = newInternalId("ver");
  return {
    intent,
    draftId,
    versionId,
    accountId: auth.accountId,
    apiTokenId: auth.id,
    title: `${intent} draft`,
    objectKey: `drafts/${draftId}/versions/${versionId}.html`,
    contentHash: `sha256:${versionId}`,
    fileSize: 1,
    filename: "plan.html",
    metadata: { cliVersion: "contract-test" },
    sourceIp: "127.0.0.1",
    userAgent: "vitest",
    ...overrides
  };
}

interface TestPoolClient {
  query(text: string, values?: unknown[]): Promise<unknown>;
  release(): void;
}

function failRollbackAfterExecution(db: PostgresPatchPageDb): void {
  const pool = (
    db as unknown as {
      pool: { connect(): Promise<TestPoolClient> };
    }
  ).pool;
  const connect = pool.connect.bind(pool);
  pool.connect = async () => {
    const client = await connect();
    return {
      async query(text, values) {
        const result =
          values === undefined ? await client.query(text) : await client.query(text, values);
        if (text === "ROLLBACK") {
          throw new Error("Forced rollback failure after server execution.");
        }
        return result;
      },
      release() {
        client.release();
      }
    };
  };
}

async function captureError(promise: Promise<RecordUploadResult>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error
  );
}
