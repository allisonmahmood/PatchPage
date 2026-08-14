import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { newDraftId, newInternalId, randomToken } from "@patchpage/core";
import { JsonFilePatchPageDb } from "./json-db.js";
import {
  DEPLOYED_POSTGRES_SCHEMA_SQL,
  deployedJsonStateFixture,
  LEGACY_ACCOUNT_ID,
  LEGACY_DRAFT_ID,
  LEGACY_TOKEN,
  PROBE_ADD_MIGRATION,
  PROBE_ADD_MIGRATION_ID,
  PROBE_REQUIRE_MIGRATION,
  PROBE_REQUIRE_MIGRATION_ID,
  REVERT_PROBE_MIGRATIONS_SQL,
  SEED_DEPLOYED_ROWS_SQL
} from "./migration-fixtures.fixture.js";
import { SCHEMA_MIGRATION_IDS, SCHEMA_MIGRATIONS } from "./migrations.js";
import { PostgresPatchPageDb } from "./postgres-db.js";
import { isUploadTargetError } from "./types.js";
import type {
  ApiTokenAuth,
  DbDriverOptions,
  PatchPageDb,
  RecordUploadInput,
  RecordUploadResult
} from "./types.js";

type UploadIntent = "create" | "update";
type IntendedRecordUploadInput = RecordUploadInput & { intent: UploadIntent };

const DAY_MS = 24 * 60 * 60 * 1000;
/** Where the retention tests start their clock. Any fixed instant would do. */
const RETENTION_EPOCH = Date.UTC(2026, 0, 1);

interface ContractHarness {
  db: PatchPageDb;
  peerDb: PatchPageDb;
  auth: ApiTokenAuth;
  /** Another handle on the same store, optionally running a different schema. */
  openDb(options?: DbDriverOptions): PatchPageDb;
  /** Rebuilds the store exactly as the code before this mechanism left it. */
  resetToDeployedSchema(): Promise<void>;
  /** Rewrites the ledger, to resume from a prefix of the migration list. */
  setAppliedLedger(ids: readonly string[]): Promise<void>;
  /** Undoes the probe migrations so the store stays reusable across runs. */
  revertProbeMigrations(): Promise<void>;
  close(): Promise<void>;
}

function shippedLedgerEntries(applied: string[]): string[] {
  return applied.filter((id) => SCHEMA_MIGRATION_IDS.includes(id));
}

async function captureInitializeError(db: PatchPageDb): Promise<unknown> {
  return db.initialize(null).then(
    () => null,
    (error: unknown) => error
  );
}

type ContractHarnessFactory = () => Promise<ContractHarness>;

function describeUploadContract(
  driverName: string,
  createHarness: ContractHarnessFactory,
  enabled = true
): void {
  const suite = enabled ? describe : describe.skip;

  suite(`${driverName} draft upload contract`, () => {
    it("records every shipped migration once, in order, and re-migrates as a no-op", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();

      try {
        const applied = await harness.db.listAppliedMigrations();
        expect(shippedLedgerEntries(applied)).toEqual([...SCHEMA_MIGRATION_IDS]);
        expect(new Set(applied).size).toBe(applied.length);

        await harness.db.initialize(null);
        await harness.peerDb.initialize(null);

        expect(await harness.db.listAppliedMigrations()).toEqual(applied);
        const created = await harness.db.recordUpload(
          uploadInput("create", draftId, harness.auth)
        );
        expect(created.versionNumber).toBe(1);
      } finally {
        await harness.close();
      }
    });

    it("resumes from a partly applied ledger without repeating a recorded step", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();

      try {
        await harness.setAppliedLedger(SCHEMA_MIGRATION_IDS.slice(0, 1));

        const resumed = harness.openDb();
        await resumed.initialize(null);

        const applied = await resumed.listAppliedMigrations();
        expect(shippedLedgerEntries(applied)).toEqual([...SCHEMA_MIGRATION_IDS]);
        expect(new Set(applied).size).toBe(applied.length);

        const created = await resumed.recordUpload(
          uploadInput("create", draftId, harness.auth)
        );
        expect(created.versionNumber).toBe(1);
      } finally {
        await harness.close();
      }
    });

    it("adopts a database created before this mechanism existed", async () => {
      const harness = await createHarness();

      try {
        await harness.resetToDeployedSchema();

        const adopted = harness.openDb();
        await adopted.initialize(null);

        expect(shippedLedgerEntries(await adopted.listAppliedMigrations())).toEqual([
          ...SCHEMA_MIGRATION_IDS
        ]);

        const legacyAuth = await adopted.findApiTokenByToken(LEGACY_TOKEN);
        expect(legacyAuth?.accountId).toBe(LEGACY_ACCOUNT_ID);
        const preserved = await adopted.findDraftVersion(LEGACY_DRAFT_ID);
        expect(preserved.draft?.title).toBe("Legacy draft");
        expect(preserved.version?.versionNumber).toBe(1);

        const updated = await adopted.recordUpload(
          uploadInput("update", LEGACY_DRAFT_ID, legacyAuth!)
        );
        expect(updated.versionNumber).toBe(2);
      } finally {
        await harness.close();
      }
    });

    it("applies an additive migration to an already-migrated database", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();

      try {
        await harness.db.recordUpload(uploadInput("create", draftId, harness.auth));

        const upgraded = harness.openDb({
          migrations: [...SCHEMA_MIGRATIONS, PROBE_ADD_MIGRATION, PROBE_REQUIRE_MIGRATION]
        });
        await upgraded.initialize(null);

        const applied = await upgraded.listAppliedMigrations();
        expect(shippedLedgerEntries(applied)).toEqual([...SCHEMA_MIGRATION_IDS]);
        expect(applied.slice(-2)).toEqual([
          PROBE_ADD_MIGRATION_ID,
          PROBE_REQUIRE_MIGRATION_ID
        ]);

        const preserved = await upgraded.findDraftVersion(draftId);
        expect(preserved.draft?.id).toBe(draftId);
        const updated = await upgraded.recordUpload(
          uploadInput("update", draftId, harness.auth)
        );
        expect(updated.versionNumber).toBe(2);

        await upgraded.initialize(null);
        expect(await upgraded.listAppliedMigrations()).toEqual(applied);

        // A handle still running the older schema keeps reading migrated rows.
        expect((await harness.db.findDraftVersion(draftId)).draft?.id).toBe(draftId);
      } finally {
        await harness.revertProbeMigrations();
        await harness.close();
      }
    });

    it("fails an additive migration whose predecessor never ran", async () => {
      const harness = await createHarness();

      try {
        await harness.db.recordUpload(uploadInput("create", newDraftId(), harness.auth));

        // The dependent probe alone: if the step that adds the field were a
        // no-op, this would pass, so the failure is what proves it ran above.
        const incomplete = harness.openDb({
          migrations: [...SCHEMA_MIGRATIONS, PROBE_REQUIRE_MIGRATION]
        });

        const error = await captureInitializeError(incomplete);
        expect(error).toBeInstanceOf(Error);
        expect(shippedLedgerEntries(await harness.db.listAppliedMigrations())).toEqual([
          ...SCHEMA_MIGRATION_IDS
        ]);
        expect(await harness.db.listAppliedMigrations()).not.toContain(
          PROBE_REQUIRE_MIGRATION_ID
        );
      } finally {
        await harness.revertProbeMigrations();
        await harness.close();
      }
    });

    it("moderates a draft for its owning principal or an authorized moderator", async () => {
      const harness = await createHarness();
      // Every draft is created by the harness principal, which is a real row:
      // `drafts.account_id` carries a foreign key, so an invented owner would
      // fail to insert on Postgres while passing on the key-less JSON driver.
      // A non-owner is expressed by the *acting* principal instead, which is
      // only ever compared, never inserted.
      const otherPrincipalId = `${harness.auth.accountId}_not`;
      const ownerDisabledDraftId = newDraftId();
      const ownerDeletedDraftId = newDraftId();
      const moderatedDisabledDraftId = newDraftId();
      const moderatedDeletedDraftId = newDraftId();

      try {
        for (const draftId of [
          ownerDisabledDraftId,
          ownerDeletedDraftId,
          moderatedDisabledDraftId,
          moderatedDeletedDraftId
        ]) {
          await harness.db.recordUpload(uploadInput("create", draftId, harness.auth));
        }

        // Ordinary reach is ownership alone.
        await expect(
          harness.db.disableDraft(ownerDisabledDraftId, otherPrincipalId, "not the owner")
        ).resolves.toBe(false);
        await expect(
          harness.db.deleteDraft(ownerDeletedDraftId, otherPrincipalId)
        ).resolves.toBe(false);

        await expect(
          harness.db.disableDraft(
            ownerDisabledDraftId,
            harness.auth.accountId,
            "owner policy"
          )
        ).resolves.toBe(true);
        await expect(
          harness.db.deleteDraft(ownerDeletedDraftId, harness.auth.accountId)
        ).resolves.toBe(true);

        // An authorized moderator reaches a draft it does not own. This is the
        // operator's takedown path, keyed on nothing but the granted capability.
        await expect(
          harness.db.disableDraft(
            moderatedDisabledDraftId,
            otherPrincipalId,
            "operator policy",
            { canModerateAnyPrincipal: true }
          )
        ).resolves.toBe(true);
        await expect(
          harness.db.deleteDraft(moderatedDeletedDraftId, otherPrincipalId, {
            canModerateAnyPrincipal: true
          })
        ).resolves.toBe(true);

        // Moderation still cannot resurrect an already-deleted draft.
        await expect(
          harness.db.deleteDraft(moderatedDeletedDraftId, otherPrincipalId, {
            canModerateAnyPrincipal: true
          })
        ).resolves.toBe(false);
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

    it("counts a token's live drafts, excluding deleted and disabled ones", async () => {
      const harness = await createHarness();
      const kept = newDraftId();
      const deleted = newDraftId();
      const disabled = newDraftId();
      const foreign = newDraftId();

      try {
        const creator = await createUploadToken(harness, "Quota creator token");
        const other = await createUploadToken(harness, "Quota other token");

        expect(await harness.db.countLiveDraftsByCreatorApiToken(creator.id)).toBe(0);

        for (const draftId of [kept, deleted, disabled]) {
          await harness.db.recordUpload(uploadInput("create", draftId, creator));
        }
        await harness.db.recordUpload(uploadInput("create", foreign, other));

        expect(await harness.db.countLiveDraftsByCreatorApiToken(creator.id)).toBe(3);
        expect(await harness.db.countLiveDraftsByCreatorApiToken(other.id)).toBe(1);

        await harness.db.deleteDraft(deleted, creator.accountId);
        await harness.db.disableDraft(disabled, creator.accountId, "policy");

        expect(await harness.db.countLiveDraftsByCreatorApiToken(creator.id)).toBe(1);
        expect(await harness.db.countLiveDraftsByCreatorApiToken(other.id)).toBe(1);
        expect(
          await harness.db.countLiveDraftsByCreatorApiToken("tok_never_used")
        ).toBe(0);
      } finally {
        await harness.close();
      }
    });

    it("keeps a draft in its creator's tally when another token updates it", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();

      try {
        const creator = await createUploadToken(harness, "Quota update creator token");
        const editor = await createUploadToken(harness, "Quota update editor token");

        await harness.db.recordUpload(uploadInput("create", draftId, creator));
        const updated = await harness.db.recordUpload(
          uploadInput("update", draftId, editor)
        );

        expect(updated.versionNumber).toBe(2);
        expect(await harness.db.countLiveDraftsByCreatorApiToken(creator.id)).toBe(1);
        expect(await harness.db.countLiveDraftsByCreatorApiToken(editor.id)).toBe(0);
      } finally {
        await harness.close();
      }
    });

    it("counts self-service mints per source address across a rolling day", async () => {
      const harness = await createHarness();
      const sourceIp = uniqueSourceIp();
      const otherIp = uniqueSourceIp();
      // Anchored at the wall clock so the default-clock peer handle below reads
      // the same window this one writes into.
      let now = Date.now();
      const clocked = harness.openDb({ clock: () => now });

      try {
        await clocked.initialize(null);
        expect(await clocked.countSelfServiceMintsBySourceIp(sourceIp)).toBe(0);

        await mintToken(clocked, sourceIp);
        await mintToken(clocked, sourceIp);
        await mintToken(clocked, otherIp);

        expect(await clocked.countSelfServiceMintsBySourceIp(sourceIp)).toBe(2);
        expect(await clocked.countSelfServiceMintsBySourceIp(otherIp)).toBe(1);

        // The tally is stored, not remembered: another handle on the same store
        // counts the same mints without having seen one of them happen.
        expect(await harness.peerDb.countSelfServiceMintsBySourceIp(sourceIp)).toBe(2);

        // A mint the server could not attribute lands in a bucket of its own
        // rather than escaping the count altogether.
        const unattributedBefore = await clocked.countSelfServiceMintsBySourceIp(null);
        await mintToken(clocked, null);
        expect(await clocked.countSelfServiceMintsBySourceIp(null)).toBe(
          unattributedBefore + 1
        );
        expect(await clocked.countSelfServiceMintsBySourceIp(sourceIp)).toBe(2);

        // Still inside the day, then past it: the window rolls off the mints
        // themselves rather than resetting at a fixed hour.
        now += DAY_MS - 1_000;
        expect(await clocked.countSelfServiceMintsBySourceIp(sourceIp)).toBe(2);
        now += 2_000;
        expect(await clocked.countSelfServiceMintsBySourceIp(sourceIp)).toBe(0);
      } finally {
        await harness.close();
      }
    });

    it("mints a fresh marked principal holding one upload-only token", async () => {
      const harness = await createHarness();
      const token = randomToken();
      const name = "Self-service token 2026-01-01";

      try {
        const minted = await harness.db.mintSelfServiceToken({
          token,
          name,
          sourceIp: uniqueSourceIp()
        });

        const auth = await harness.db.findApiTokenByToken(token);
        expect(auth).toMatchObject({
          id: minted.apiTokenId,
          accountId: minted.accountId,
          name,
          scopes: ["upload"],
          // The provenance mark, read back on the path every request takes.
          selfService: true
        });
        expect(minted.apiTokenName).toBe(name);

        // The operator's own principal was seeded, not minted, so it is unmarked.
        expect(harness.auth.selfService).toBe(false);

        // One principal per mint, and one token per principal.
        const second = await harness.db.mintSelfServiceToken({
          token: randomToken(),
          name,
          sourceIp: uniqueSourceIp()
        });
        expect(second.accountId).not.toBe(minted.accountId);
        expect(second.apiTokenId).not.toBe(minted.apiTokenId);
      } finally {
        await harness.close();
      }
    });

    it("owns exactly the drafts a minted principal creates", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();

      try {
        const minted = await mintedAuth(harness, uniqueSourceIp());

        await harness.db.recordUpload(uploadInput("create", draftId, minted));
        const own = await harness.db.recordUpload(uploadInput("update", draftId, minted));
        expect(own.versionNumber).toBe(2);

        // Ownership is the existing account-scoped check, reused unchanged: the
        // operator's principal is simply a different account, so its update is
        // refused exactly as any other stranger's would be.
        const foreign = await captureError(
          harness.db.recordUpload(uploadInput("update", draftId, harness.auth))
        );
        expect(isUploadTargetError(foreign)).toBe(true);
        expect(foreign).toMatchObject({ code: "draft_unavailable" });

        expect(await harness.db.countLiveDraftsByCreatorApiToken(minted.id)).toBe(1);
        expect(await harness.db.deleteDraft(draftId, harness.auth.accountId)).toBe(false);
        expect(await harness.db.deleteDraft(draftId, minted.accountId)).toBe(true);
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

    it("starts a full retention window on create and restarts it on every new version", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();
      let now = RETENTION_EPOCH;
      const clocked = harness.openDb({ clock: () => now });

      try {
        await clocked.recordUpload(uploadInput("create", draftId, harness.auth));

        now = RETENTION_EPOCH + 80 * DAY_MS;
        await clocked.recordUpload(uploadInput("update", draftId, harness.auth));

        // Past the window the create opened, inside the one the update opened.
        now = RETENTION_EPOCH + 100 * DAY_MS;
        expect((await clocked.findDraftVersion(draftId)).draft?.id).toBe(draftId);

        now = RETENTION_EPOCH + 171 * DAY_MS;
        expect((await clocked.findDraftVersion(draftId)).draft).toBeNull();
      } finally {
        await harness.close();
      }
    });

    it("stops serving an expired draft and refuses it as an update target", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();
      let now = RETENTION_EPOCH;
      const clocked = harness.openDb({ clock: () => now });

      try {
        await clocked.recordUpload(uploadInput("create", draftId, harness.auth));

        now = RETENTION_EPOCH + 90 * DAY_MS - 1;
        expect((await clocked.findDraftVersion(draftId)).version?.versionNumber).toBe(1);

        now = RETENTION_EPOCH + 90 * DAY_MS + 1;
        expect(await clocked.findDraftVersion(draftId)).toEqual({
          draft: null,
          version: null
        });
        expect(await clocked.findDraftVersion(draftId, 1)).toEqual({
          draft: null,
          version: null
        });

        const target = clocked.assertUploadTarget({
          intent: "update",
          draftId,
          accountId: harness.auth.accountId
        });
        await expect(target).rejects.toMatchObject({
          code: "draft_unavailable",
          statusCode: 404
        });

        const update = await captureError(
          clocked.recordUpload(uploadInput("update", draftId, harness.auth))
        );
        expect(isUploadTargetError(update)).toBe(true);
        expect(update).toMatchObject({ code: "draft_unavailable", statusCode: 404 });

        // Out of view is not out of the store — only the sweep frees the ID,
        // so a create still collides with the row until then.
        const recreated = await captureError(
          clocked.recordUpload(uploadInput("create", draftId, harness.auth))
        );
        expect(recreated).toMatchObject({ code: "draft_conflict", statusCode: 409 });
      } finally {
        await harness.close();
      }
    });

    it("serves a draft at the exact instant its clock reads out, and not past it", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();
      let now = RETENTION_EPOCH;
      const clocked = harness.openDb({ clock: () => now });

      try {
        await clocked.recordUpload(uploadInput("create", draftId, harness.auth));

        // The rule is `expiresAt < now`, so the anchor instant itself is still
        // inside the window. A `<=` anywhere in either driver fails here.
        now = RETENTION_EPOCH + 90 * DAY_MS;
        expect((await clocked.findDraftVersion(draftId)).draft?.id).toBe(draftId);

        now += 1;
        expect((await clocked.findDraftVersion(draftId)).draft).toBeNull();
      } finally {
        await harness.close();
      }
    });

    it("leaves the clock alone for a visit with exactly the visit window left", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();
      let now = RETENTION_EPOCH;
      const clocked = harness.openDb({ clock: () => now });

      try {
        await clocked.recordUpload(uploadInput("create", draftId, harness.auth));

        // Exactly the visit window remains. "Fewer than" is not met, so this is
        // a no-op — and because a top-up here would land on the value already
        // stored, the boundary is only visible as the write that never happens.
        now = RETENTION_EPOCH + 60 * DAY_MS;
        await clocked.recordDraftVisit(draftId);

        now = RETENTION_EPOCH + 90 * DAY_MS;
        expect((await clocked.findDraftVersion(draftId)).draft?.id).toBe(draftId);

        now += 1;
        expect((await clocked.findDraftVersion(draftId)).draft).toBeNull();
      } finally {
        await harness.close();
      }
    });

    it("tops a visited draft up to the visit window when less than it remains", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();
      let now = RETENTION_EPOCH;
      const clocked = harness.openDb({ clock: () => now });

      try {
        await clocked.recordUpload(uploadInput("create", draftId, harness.auth));

        now = RETENTION_EPOCH + 70 * DAY_MS; // twenty days left
        await clocked.recordDraftVisit(draftId);

        now = RETENTION_EPOCH + 99 * DAY_MS; // past the window the upload opened
        expect((await clocked.findDraftVersion(draftId)).draft?.id).toBe(draftId);

        now = RETENTION_EPOCH + 101 * DAY_MS; // past the topped-up one
        expect((await clocked.findDraftVersion(draftId)).draft).toBeNull();
      } finally {
        await harness.close();
      }
    });

    it("leaves the clock untouched for a visit with more than the visit window left", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();
      let now = RETENTION_EPOCH;
      const clocked = harness.openDb({ clock: () => now });

      try {
        await clocked.recordUpload(uploadInput("create", draftId, harness.auth));

        now = RETENTION_EPOCH + 10 * DAY_MS; // eighty days left
        await clocked.recordDraftVisit(draftId);

        // Not shortened to the visit window...
        now = RETENTION_EPOCH + 89 * DAY_MS;
        expect((await clocked.findDraftVersion(draftId)).draft?.id).toBe(draftId);

        // ...and not extended past the window the upload opened either.
        now = RETENTION_EPOCH + 91 * DAY_MS;
        expect((await clocked.findDraftVersion(draftId)).draft).toBeNull();
      } finally {
        await harness.close();
      }
    });

    it("never revives an expired draft on a visit", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();
      let now = RETENTION_EPOCH;
      const clocked = harness.openDb({ clock: () => now });

      try {
        await clocked.recordUpload(uploadInput("create", draftId, harness.auth));

        now = RETENTION_EPOCH + 91 * DAY_MS;
        await clocked.recordDraftVisit(draftId);
        await clocked.recordDraftVisit(draftId);

        expect((await clocked.findDraftVersion(draftId)).draft).toBeNull();
        now = RETENTION_EPOCH + 92 * DAY_MS;
        expect((await clocked.findDraftVersion(draftId)).draft).toBeNull();
      } finally {
        await harness.close();
      }
    });

    it("accepts a visit to a draft nobody can be served as a no-op", async () => {
      const harness = await createHarness();
      const deletedDraftId = newDraftId();
      const disabledDraftId = newDraftId();

      try {
        for (const draftId of [deletedDraftId, disabledDraftId]) {
          await harness.db.recordUpload(uploadInput("create", draftId, harness.auth));
        }
        await harness.db.deleteDraft(deletedDraftId, harness.auth.accountId);
        await harness.db.disableDraft(disabledDraftId, harness.auth.accountId, "policy");

        for (const draftId of [deletedDraftId, disabledDraftId, newDraftId()]) {
          await expect(harness.db.recordDraftVisit(draftId)).resolves.toBeUndefined();
          expect((await harness.db.findDraftVersion(draftId)).draft).toBeNull();
        }
      } finally {
        await harness.close();
      }
    });

    it("leaves a draft migrated from before the retention clock a full window", async () => {
      const harness = await createHarness();

      try {
        await harness.resetToDeployedSchema();

        const migratedAt = Date.now();
        const adopted = harness.openDb();
        await adopted.initialize(null);

        // The deploy expires nothing: a row written long before the clock
        // existed still serves the moment the migration lands.
        expect((await adopted.findDraftVersion(LEGACY_DRAFT_ID)).draft?.title).toBe(
          "Legacy draft"
        );

        // And what it has ahead of it is a whole window, anchored at the
        // migration rather than at whenever the row was last written.
        let now = migratedAt;
        const clocked = harness.openDb({ clock: () => now });
        now = migratedAt + 89 * DAY_MS;
        expect((await clocked.findDraftVersion(LEGACY_DRAFT_ID)).draft?.id).toBe(
          LEGACY_DRAFT_ID
        );
        now = migratedAt + 91 * DAY_MS;
        expect((await clocked.findDraftVersion(LEGACY_DRAFT_ID)).draft).toBeNull();
      } finally {
        await harness.close();
      }
    });

    it("hard-deletes an expired draft with every version it held, freeing its ID", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();
      let now = RETENTION_EPOCH;
      const clocked = harness.openDb({ clock: () => now });

      try {
        const created = uploadInput("create", draftId, harness.auth);
        const updated = uploadInput("update", draftId, harness.auth);
        await clocked.recordUpload(created);
        await clocked.recordUpload(updated);

        now = RETENTION_EPOCH + 91 * DAY_MS;
        expect(await clocked.listExpiredDraftIds(1_000)).toContain(draftId);

        // Every version's object comes back, because every version's row goes.
        const objectKeys = await clocked.deleteExpiredDraft(draftId);
        expect([...(objectKeys ?? [])].sort()).toEqual(
          [created.objectKey, updated.objectKey].sort()
        );

        expect(await clocked.findDraftVersion(draftId)).toEqual({
          draft: null,
          version: null
        });
        expect(await clocked.listExpiredDraftIds(1_000)).not.toContain(draftId);
        // Sweeping twice is one sweep: there is nothing left to take.
        expect(await clocked.deleteExpiredDraft(draftId)).toBeNull();

        // The ID is free again. Version one is available only because the old
        // versions went with the draft — republishing is the way back.
        const republished = await clocked.recordUpload(
          uploadInput("create", draftId, harness.auth)
        );
        expect(republished.versionNumber).toBe(1);
      } finally {
        await harness.close();
      }
    });

    it("offers nothing to sweep while a draft's clock still runs", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();
      let now = RETENTION_EPOCH;
      const clocked = harness.openDb({ clock: () => now });

      try {
        await clocked.recordUpload(uploadInput("create", draftId, harness.auth));

        now = RETENTION_EPOCH + 90 * DAY_MS;
        expect(await clocked.listExpiredDraftIds(1_000)).not.toContain(draftId);
        expect(await clocked.deleteExpiredDraft(draftId)).toBeNull();
        expect((await clocked.findDraftVersion(draftId)).draft?.id).toBe(draftId);

        now += 1;
        expect(await clocked.listExpiredDraftIds(1_000)).toContain(draftId);
        // A caller asking for no drafts is asked for no drafts.
        expect(await clocked.listExpiredDraftIds(0)).toEqual([]);
        expect(await clocked.deleteExpiredDraft(draftId)).not.toBeNull();
      } finally {
        await harness.close();
      }
    });

    it("offers the longest-expired drafts first", async () => {
      const harness = await createHarness();
      const older = newDraftId();
      const newer = newDraftId();
      let now = RETENTION_EPOCH;
      const clocked = harness.openDb({ clock: () => now });

      try {
        await clocked.recordUpload(uploadInput("create", older, harness.auth));
        now = RETENTION_EPOCH + 10 * DAY_MS;
        await clocked.recordUpload(uploadInput("create", newer, harness.auth));

        now = RETENTION_EPOCH + 101 * DAY_MS;
        const listed = await clocked.listExpiredDraftIds(1_000);
        // Other drafts may be waiting too; only the relative order is the rule.
        expect(listed.filter((id) => id === older || id === newer)).toEqual([older, newer]);

        for (const draftId of [older, newer]) {
          expect(await clocked.deleteExpiredDraft(draftId)).not.toBeNull();
        }
      } finally {
        await harness.close();
      }
    });

    it("sweeps deleted and disabled drafts once their clock runs out", async () => {
      const harness = await createHarness();
      const deletedDraftId = newDraftId();
      const disabledDraftId = newDraftId();
      let now = RETENTION_EPOCH;
      const clocked = harness.openDb({ clock: () => now });

      try {
        for (const draftId of [deletedDraftId, disabledDraftId]) {
          await clocked.recordUpload(uploadInput("create", draftId, harness.auth));
        }
        await clocked.deleteDraft(deletedDraftId, harness.auth.accountId);
        await clocked.disableDraft(disabledDraftId, harness.auth.accountId, "policy");

        // Out of sight is not out of storage: their clocks run out like any
        // other draft's, and the sweep is what finally frees what they hold.
        now = RETENTION_EPOCH + 91 * DAY_MS;
        const listed = await clocked.listExpiredDraftIds(1_000);
        for (const draftId of [deletedDraftId, disabledDraftId]) {
          expect(listed).toContain(draftId);
          expect(await clocked.deleteExpiredDraft(draftId)).not.toBeNull();
        }
      } finally {
        await harness.close();
      }
    });

    it("returns a swept draft's slot to its creator's live tally", async () => {
      const harness = await createHarness();
      const draftIds = [newDraftId(), newDraftId()];
      let now = RETENTION_EPOCH;
      const clocked = harness.openDb({ clock: () => now });

      try {
        const creator = await createUploadToken(harness, "Expiry sweep quota token");
        for (const draftId of draftIds) {
          await clocked.recordUpload(uploadInput("create", draftId, creator));
        }
        expect(await clocked.countLiveDraftsByCreatorApiToken(creator.id)).toBe(2);

        // An expired draft still counts: its row and its content are both there.
        now = RETENTION_EPOCH + 91 * DAY_MS;
        expect(await clocked.countLiveDraftsByCreatorApiToken(creator.id)).toBe(2);

        for (const draftId of draftIds) {
          expect(await clocked.deleteExpiredDraft(draftId)).not.toBeNull();
        }
        expect(await clocked.countLiveDraftsByCreatorApiToken(creator.id)).toBe(0);
      } finally {
        await harness.close();
      }
    });

    it("holds a pinned draft out of expiry, and hands it back on unpin", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();
      let now = RETENTION_EPOCH;
      const clocked = harness.openDb({ clock: () => now });

      try {
        await clocked.recordUpload(uploadInput("create", draftId, harness.auth));
        expect(await clocked.setDraftPinned(draftId, true)).toBe(true);

        // Long past the window an upload opens, and none of it applies.
        now = RETENTION_EPOCH + 200 * DAY_MS;
        expect((await clocked.findDraftVersion(draftId)).draft?.pinnedAt).toEqual(
          expect.any(String)
        );
        expect(await clocked.listExpiredDraftIds(1_000)).not.toContain(draftId);
        expect(await clocked.deleteExpiredDraft(draftId)).toBeNull();

        // Ordinary in every other respect: its owner still updates it.
        const updated = await clocked.recordUpload(
          uploadInput("update", draftId, harness.auth)
        );
        expect(updated.versionNumber).toBe(2);

        now = RETENTION_EPOCH + 400 * DAY_MS;
        expect((await clocked.findDraftVersion(draftId)).draft?.id).toBe(draftId);

        // Unpinning hands the draft back to the clock it was always carrying.
        expect(await clocked.setDraftPinned(draftId, false)).toBe(true);
        expect((await clocked.findDraftVersion(draftId)).draft).toBeNull();
        expect(await clocked.listExpiredDraftIds(1_000)).toContain(draftId);
        expect(await clocked.deleteExpiredDraft(draftId)).not.toBeNull();
      } finally {
        await harness.close();
      }
    });

    it("keeps a pinned draft's clock moving, so unpinning a read page leaves it a window", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();
      let now = RETENTION_EPOCH;
      const clocked = harness.openDb({ clock: () => now });

      try {
        await clocked.recordUpload(uploadInput("create", draftId, harness.auth));
        expect(await clocked.setDraftPinned(draftId, true)).toBe(true);

        // A visit long past the anchor still tops up, because a pinned draft is
        // not expired and topping it up therefore revives nothing.
        now = RETENTION_EPOCH + 200 * DAY_MS;
        await clocked.recordDraftVisit(draftId);
        expect(await clocked.setDraftPinned(draftId, false)).toBe(true);

        now = RETENTION_EPOCH + 229 * DAY_MS;
        expect((await clocked.findDraftVersion(draftId)).draft?.id).toBe(draftId);

        now = RETENTION_EPOCH + 231 * DAY_MS;
        expect((await clocked.findDraftVersion(draftId)).draft).toBeNull();
        expect(await clocked.deleteExpiredDraft(draftId)).not.toBeNull();
      } finally {
        await harness.close();
      }
    });

    it("pins only a draft in service, and unpins whatever row is left", async () => {
      const harness = await createHarness();
      const deletedDraftId = newDraftId();
      const disabledDraftId = newDraftId();

      try {
        expect(await harness.db.setDraftPinned(newDraftId(), true)).toBe(false);

        await harness.db.recordUpload(uploadInput("create", deletedDraftId, harness.auth));
        await harness.db.recordUpload(uploadInput("create", disabledDraftId, harness.auth));
        await harness.db.deleteDraft(deletedDraftId, harness.auth.accountId);
        await harness.db.disableDraft(disabledDraftId, harness.auth.accountId, "policy");

        // A pin is a statement about a live page, so there is nothing here to
        // exempt — pinning one of these would exempt unreachable storage.
        expect(await harness.db.setDraftPinned(deletedDraftId, true)).toBe(false);
        expect(await harness.db.setDraftPinned(disabledDraftId, true)).toBe(false);

        // Unpinning is the other way round: it takes any row still there, so a
        // pin can never be stuck on a draft the operator has since taken down.
        expect(await harness.db.setDraftPinned(deletedDraftId, false)).toBe(true);
        expect(await harness.db.setDraftPinned(disabledDraftId, false)).toBe(true);
        expect(await harness.db.setDraftPinned(newDraftId(), false)).toBe(false);
      } finally {
        await harness.close();
      }
    });

    it("ends a pin when a draft is taken out of service, so its storage still frees", async () => {
      const harness = await createHarness();
      const deletedDraftId = newDraftId();
      const disabledDraftId = newDraftId();
      let now = RETENTION_EPOCH;
      const clocked = harness.openDb({ clock: () => now });

      try {
        for (const draftId of [deletedDraftId, disabledDraftId]) {
          await clocked.recordUpload(uploadInput("create", draftId, harness.auth));
          expect(await clocked.setDraftPinned(draftId, true)).toBe(true);
        }

        // Taking a draft down outranks its pin. Without that, the row would be
        // exempt from the sweep with no way to unpin it back into reach.
        await clocked.deleteDraft(deletedDraftId, harness.auth.accountId);
        await clocked.disableDraft(disabledDraftId, harness.auth.accountId, "policy");

        now = RETENTION_EPOCH + 91 * DAY_MS;
        const listed = await clocked.listExpiredDraftIds(1_000);
        for (const draftId of [deletedDraftId, disabledDraftId]) {
          expect(listed).toContain(draftId);
          expect(await clocked.deleteExpiredDraft(draftId)).not.toBeNull();
        }
      } finally {
        await harness.close();
      }
    });

    it("stores a reader's report against the draft it names, with or without a reason", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();
      const otherDraftId = newDraftId();

      try {
        for (const id of [draftId, otherDraftId]) {
          await harness.db.recordUpload(uploadInput("create", id, harness.auth));
        }

        const filed = await harness.db.recordDraftReport({
          draftId,
          sourceIp: "203.0.113.7",
          reason: "  Impersonates my company.  "
        });
        expect(filed.draftId).toBe(draftId);
        expect(filed.sourceIp).toBe("203.0.113.7");
        // The drivers agree on trimming and on the stored ceiling.
        expect(filed.reason).toBe("Impersonates my company.");
        expect(filed.id).toMatch(/^rpt_/);
        expect(Number.isNaN(Date.parse(filed.createdAt))).toBe(false);

        await harness.db.recordDraftReport({
          draftId,
          sourceIp: null,
          reason: null
        });
        await harness.db.recordDraftReport({
          draftId: otherDraftId,
          sourceIp: "198.51.100.4",
          reason: "Unrelated."
        });

        const reports = await harness.db.listDraftReports(draftId);
        expect(reports).toHaveLength(2);
        expect(reports.map((report) => report.reason).sort()).toEqual([
          "Impersonates my company.",
          null
        ]);
        expect(reports.every((report) => report.draftId === draftId)).toBe(true);
        // A reader who files without a reason is still a stored report.
        expect(reports.some((report) => report.reason === null && report.sourceIp === null)).toBe(
          true
        );

        // Reports are per draft: the neighbouring draft's report is its own.
        expect(await harness.db.listDraftReports(otherDraftId)).toHaveLength(1);
        expect(await harness.db.listDraftReports(newDraftId())).toEqual([]);
      } finally {
        await harness.close();
      }
    });

    it("truncates an overlong report reason rather than storing it whole", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();

      try {
        await harness.db.recordUpload(uploadInput("create", draftId, harness.auth));

        const filed = await harness.db.recordDraftReport({
          draftId,
          sourceIp: "203.0.113.9",
          reason: "x".repeat(4_000)
        });
        expect(filed.reason).toBe("x".repeat(255));
      } finally {
        await harness.close();
      }
    });

    it("leaves a reported draft exactly as servable as an unreported one", async () => {
      const harness = await createHarness();
      const reportedId = newDraftId();
      const quietId = newDraftId();

      try {
        for (const id of [reportedId, quietId]) {
          await harness.db.recordUpload(uploadInput("create", id, harness.auth));
        }

        const before = await harness.db.findDraftVersion(reportedId);

        // Report-bombing is the case that matters: no count of reports is a
        // takedown, because nothing reads this table but an operator.
        for (let index = 0; index < 50; index += 1) {
          await harness.db.recordDraftReport({
            draftId: reportedId,
            sourceIp: `203.0.113.${index % 256}`,
            reason: `Bomb ${index}.`
          });
        }
        expect(await harness.db.listDraftReports(reportedId)).toHaveLength(50);

        const after = await harness.db.findDraftVersion(reportedId);
        expect(after.draft?.id).toBe(reportedId);
        expect(after.draft?.disabledAt).toBeNull();
        expect(after.draft?.deletedAt).toBeNull();
        // Not one field of the draft moved, the retention clock included.
        expect(after.draft).toEqual(before.draft);
        expect(after.version?.id).toBe(before.version?.id);

        // And the draft nobody reported is untouched either way.
        expect((await harness.db.findDraftVersion(quietId)).draft?.id).toBe(quietId);
        expect(await harness.db.listDraftReports(quietId)).toEqual([]);
      } finally {
        await harness.close();
      }
    });

    it("keeps a report after the draft it flags is gone", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();

      try {
        await harness.db.recordUpload(uploadInput("create", draftId, harness.auth));
        await harness.db.recordDraftReport({
          draftId,
          sourceIp: "203.0.113.11",
          reason: "Reported, then removed."
        });

        // An operator reviewing a report after acting on it still has to be
        // able to see what was filed — which is why the report does not
        // reference the draft row.
        await harness.db.deleteDraft(draftId, harness.auth.accountId);
        expect((await harness.db.findDraftVersion(draftId)).draft).toBeNull();

        const reports = await harness.db.listDraftReports(draftId);
        expect(reports).toHaveLength(1);
        expect(reports[0]?.reason).toBe("Reported, then removed.");
      } finally {
        await harness.close();
      }
    });

    it("keeps a report after the expiry sweep hard-deletes the draft it flags", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();
      let now = RETENTION_EPOCH;
      const clocked = harness.openDb({ clock: () => now });

      try {
        await clocked.recordUpload(uploadInput("create", draftId, harness.auth));
        await clocked.recordDraftReport({
          draftId,
          sourceIp: "203.0.113.13",
          reason: "Reported, then expired."
        });

        // The sweep is a hard delete of the draft, its versions, and its stored
        // bytes. Reports are none of those: they are the operator's record that
        // something was flagged, and that record has to survive the page it was
        // filed against. The sweep must never grow a step that removes them —
        // and no foreign key exists that would force it to.
        now = RETENTION_EPOCH + 91 * DAY_MS;
        expect(await clocked.listExpiredDraftIds(1_000)).toContain(draftId);
        expect(await clocked.deleteExpiredDraft(draftId)).not.toBeNull();
        expect((await clocked.findDraftVersion(draftId)).draft).toBeNull();

        const reports = await clocked.listDraftReports(draftId);
        expect(reports).toHaveLength(1);
        expect(reports[0]?.reason).toBe("Reported, then expired.");
        expect(reports[0]?.sourceIp).toBe("203.0.113.13");
      } finally {
        await harness.close();
      }
    });

    it("attributes a stored report to the address the server resolved", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();

      try {
        await harness.db.recordUpload(uploadInput("create", draftId, harness.auth));
        await harness.db.recordDraftReport({
          draftId,
          sourceIp: "198.51.100.23",
          reason: "From a specific address."
        });

        const [stored] = await harness.db.listDraftReports(draftId);
        expect(stored?.sourceIp).toBe("198.51.100.23");
      } finally {
        await harness.close();
      }
    });

    it("answers a reported draft with the principal and token behind it", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();
      let now = RETENTION_EPOCH;
      const clocked = harness.openDb({ clock: () => now });

      try {
        const creator = await createUploadToken(harness, "Moderation read creator token");
        const editor = await createUploadToken(harness, "Moderation read editor token");
        await clocked.recordUpload(uploadInput("create", draftId, creator));

        expect(await clocked.findDraftForModeration(draftId)).toMatchObject({
          id: draftId,
          accountId: harness.auth.accountId,
          createdByApiTokenId: creator.id,
          deletedAt: null,
          disabledAt: null
        });

        // The culprit is fixed at creation: a later editor never becomes it.
        await clocked.recordUpload(uploadInput("update", draftId, editor));
        expect((await clocked.findDraftForModeration(draftId))?.createdByApiTokenId).toBe(
          creator.id
        );

        // Unlike the serving read, moderation answers for a draft that is
        // already off — the operator is asked about those most of all.
        await clocked.disableDraft(draftId, harness.auth.accountId, "operator policy");
        const disabled = await clocked.findDraftForModeration(draftId);
        expect(disabled?.createdByApiTokenId).toBe(creator.id);
        expect(disabled?.disabledAt).toEqual(expect.any(String));

        await clocked.deleteDraft(draftId, harness.auth.accountId);
        expect((await clocked.findDraftForModeration(draftId))?.deletedAt).toEqual(
          expect.any(String)
        );

        // And for one whose clock ran out, which serving has stopped answering.
        now = RETENTION_EPOCH + 200 * DAY_MS;
        expect((await clocked.findDraftVersion(draftId)).draft).toBeNull();
        expect((await clocked.findDraftForModeration(draftId))?.id).toBe(draftId);

        expect(await clocked.findDraftForModeration(newDraftId())).toBeNull();
      } finally {
        await harness.close();
      }
    });

    it("lists a principal's drafts newest first, without the ones it deleted", async () => {
      const harness = await createHarness();
      const [oldest, middle, newest] = [newDraftId(), newDraftId(), newDraftId()];
      const deleted = newDraftId();
      let now = RETENTION_EPOCH;
      const clocked = harness.openDb({ clock: () => now });

      try {
        const creator = await createUploadToken(harness, "Principal listing creator token");
        for (const draftId of [deleted, oldest, middle, newest]) {
          await clocked.recordUpload(uploadInput("create", draftId, creator));
          now += DAY_MS;
        }
        await clocked.deleteDraft(deleted, harness.auth.accountId);

        // Small enough to truncate on purpose: the answer says so rather than
        // pretending to be whole.
        const page = await clocked.listDraftsByPrincipal(harness.auth.accountId, 2);
        expect(page.drafts.map((draft) => draft.id)).toEqual([newest, middle]);
        expect(page.truncated).toBe(true);
        expect(page.drafts[0]?.createdByApiTokenId).toBe(creator.id);

        const roomy = await clocked.listDraftsByPrincipal(harness.auth.accountId, 4);
        expect(roomy.drafts.map((draft) => draft.id).slice(0, 3)).toEqual([
          newest,
          middle,
          oldest
        ]);
        expect(roomy.drafts.map((draft) => draft.id)).not.toContain(deleted);

        // A principal holding nothing is an empty answer, not a truncated one.
        expect(await clocked.listDraftsByPrincipal("acct_holds_nothing", 10)).toEqual({
          drafts: [],
          truncated: false
        });
      } finally {
        await harness.close();
      }
    });

    it("revokes a token as a state its row keeps, exactly once", async () => {
      const harness = await createHarness();

      try {
        const token = randomToken();
        const created = await harness.db.createApiToken({
          accountId: harness.auth.accountId,
          name: "Revocable token",
          token,
          scopes: ["upload"]
        });
        expect(await harness.db.findApiTokenByToken(token)).not.toBeNull();

        const revocation = await harness.db.revokeApiToken(created.id);
        expect(revocation).toMatchObject({
          id: created.id,
          accountId: harness.auth.accountId,
          name: "Revocable token",
          alreadyRevoked: false
        });
        expect(revocation?.revokedAt).toEqual(expect.any(String));

        // Revoked is a state, never a deletion: the token authenticates nothing
        // any more, and the row it left behind is still there to be read.
        expect(await harness.db.findApiTokenByToken(token)).toBeNull();

        const again = await harness.db.revokeApiToken(created.id);
        expect(again).toMatchObject({ id: created.id, alreadyRevoked: true });
        // The first moment stands — it is when the drafts' top-ups froze.
        expect(again?.revokedAt).toBe(revocation?.revokedAt);

        expect(await harness.db.revokeApiToken("tok_never_existed")).toBeNull();
      } finally {
        await harness.close();
      }
    });

    it("lets only one of two concurrent revocations claim the first stamp", async () => {
      const harness = await createHarness();

      try {
        const token = randomToken();
        const created = await harness.db.createApiToken({
          accountId: harness.auth.accountId,
          name: "Doubly revoked token",
          token,
          scopes: ["upload"]
        });

        // Two handles on the same store, racing. The freeze moment is the thing
        // being protected: if both calls could stamp, the later one would move
        // it forward and hand the token's drafts back the clock they had lost.
        const [first, second] = await Promise.all([
          harness.db.revokeApiToken(created.id),
          harness.peerDb.revokeApiToken(created.id)
        ]);

        expect([first?.alreadyRevoked, second?.alreadyRevoked].sort()).toEqual([
          false,
          true
        ]);
        // Both report the same instant, and it is the one that actually stuck.
        expect(first?.revokedAt).toBe(second?.revokedAt);
        expect(await harness.db.findApiTokenByToken(token)).toBeNull();

        const settled = await harness.db.revokeApiToken(created.id);
        expect(settled).toMatchObject({ alreadyRevoked: true });
        expect(settled?.revokedAt).toBe(first?.revokedAt);
      } finally {
        await harness.close();
      }
    });

    it("freezes visit top-ups from the moment a draft's creating token is revoked", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();
      let now = RETENTION_EPOCH;
      const clocked = harness.openDb({ clock: () => now });

      try {
        const creator = await createUploadToken(harness, "Revocation freeze creator token");
        await clocked.recordUpload(uploadInput("create", draftId, creator));

        // Day 70, twenty days left: this visit lands before the revocation and
        // tops the clock up to day 100, and that extension survives.
        now = RETENTION_EPOCH + 70 * DAY_MS;
        await clocked.recordDraftVisit(draftId);

        now = RETENTION_EPOCH + 71 * DAY_MS;
        expect((await clocked.revokeApiToken(creator.id))?.alreadyRevoked).toBe(false);

        // Revocation is not a takedown: the page is still served.
        expect((await clocked.findDraftVersion(draftId)).draft?.id).toBe(draftId);

        // Day 95, five days left — before the freeze this visit would have
        // bought another thirty. Now it buys nothing.
        now = RETENTION_EPOCH + 95 * DAY_MS;
        await clocked.recordDraftVisit(draftId);

        now = RETENTION_EPOCH + 99 * DAY_MS;
        expect((await clocked.findDraftVersion(draftId)).draft?.id).toBe(draftId);

        now = RETENTION_EPOCH + 101 * DAY_MS;
        expect((await clocked.findDraftVersion(draftId)).draft).toBeNull();
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
  const opened: PatchPageDb[] = [];
  const openDb = (options: DbDriverOptions = {}): PatchPageDb => {
    const opening = new JsonFilePatchPageDb(filePath, options);
    opened.push(opening);
    return opening;
  };

  const db = openDb();
  const peerDb = openDb();
  const token = randomToken();
  await db.initialize(token);
  const auth = await db.findApiTokenByToken(token);
  if (!auth) throw new Error("Expected bootstrap authentication.");

  return {
    db,
    peerDb,
    auth,
    openDb,
    async resetToDeployedSchema() {
      await writeFile(
        filePath,
        `${JSON.stringify(deployedJsonStateFixture(), null, 2)}\n`,
        "utf8"
      );
    },
    async setAppliedLedger(ids) {
      const stored = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
      stored.schemaMigrations = [...ids];
      await writeFile(filePath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    },
    async revertProbeMigrations() {
      // The temporary state file is discarded wholesale on close.
    },
    async close() {
      await Promise.all(opened.map((opening) => opening.close()));
      await rm(tempDir, { recursive: true, force: true });
    }
  };
}

async function createPostgresHarness(connectionString: string): Promise<ContractHarness> {
  const opened: PatchPageDb[] = [];
  const openDb = (options: DbDriverOptions = {}): PatchPageDb => {
    const opening = new PostgresPatchPageDb(connectionString, options);
    opened.push(opening);
    return opening;
  };

  const db = openDb();
  const peerDb = openDb();
  const token = randomToken();
  await db.initialize(token);
  const auth = await db.findApiTokenByToken(token);
  if (!auth) throw new Error("Expected bootstrap authentication.");

  const runSql = async (sql: string, values: unknown[] = []): Promise<void> => {
    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      await client.query(sql, values);
    } finally {
      await client.end();
    }
  };

  return {
    db,
    peerDb,
    auth,
    openDb,
    async resetToDeployedSchema() {
      // Drop everything this branch built, then rebuild from the DDL string
      // origin/main shipped: no ledger table, no drafts_account_id_idx.
      await runSql(`
        DROP TABLE IF EXISTS schema_migrations, token_mints, upload_events,
          draft_versions, drafts, api_tokens, accounts CASCADE;
      `);
      await runSql(DEPLOYED_POSTGRES_SCHEMA_SQL);
      await runSql(SEED_DEPLOYED_ROWS_SQL);
    },
    async setAppliedLedger(ids) {
      await runSql("DELETE FROM schema_migrations WHERE NOT (id = ANY($1::text[]))", [
        [...ids]
      ]);
    },
    async revertProbeMigrations() {
      await runSql(REVERT_PROBE_MIGRATIONS_SQL);
      await runSql("DELETE FROM schema_migrations WHERE id = ANY($1::text[])", [
        [PROBE_ADD_MIGRATION_ID, PROBE_REQUIRE_MIGRATION_ID]
      ]);
    },
    async close() {
      await Promise.all(opened.map((opening) => opening.close()));
    }
  };
}

/**
 * A token nobody else in the suite shares. The Postgres harness reuses one
 * database across runs, so a per-token tally is only assertable from zero when
 * the token itself is new.
 */
async function createUploadToken(
  harness: ContractHarness,
  name: string
): Promise<ApiTokenAuth> {
  const token = randomToken();
  await harness.db.createApiToken({
    accountId: harness.auth.accountId,
    name,
    token,
    scopes: ["upload"]
  });
  const auth = await harness.db.findApiTokenByToken(token);
  if (!auth) throw new Error(`Expected authentication for ${name}.`);
  return auth;
}

/**
 * A source address nobody else in the suite shares. The Postgres harness reuses
 * one database across runs, so a per-address tally is only assertable from zero
 * when the address itself is new. The column is text, so this has to be unique,
 * not routable — hence the documentation range with a random host part.
 */
function uniqueSourceIp(): string {
  return `2001:db8::${randomUUID().slice(0, 8)}`;
}

async function mintToken(db: PatchPageDb, sourceIp: string | null): Promise<void> {
  await db.mintSelfServiceToken({
    token: randomToken(),
    name: "Self-service token 2026-01-01",
    sourceIp
  });
}

/** Mints, then reads back the principal the minted token authenticates as. */
async function mintedAuth(
  harness: ContractHarness,
  sourceIp: string | null
): Promise<ApiTokenAuth> {
  const token = randomToken();
  await harness.db.mintSelfServiceToken({
    token,
    name: "Self-service token 2026-01-01",
    sourceIp
  });
  const auth = await harness.db.findApiTokenByToken(token);
  if (!auth) throw new Error("Expected authentication for a minted token.");
  return auth;
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
