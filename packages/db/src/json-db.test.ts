import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonFilePatchPageDb } from "./json-db.js";

let tempDir: string;

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
});
