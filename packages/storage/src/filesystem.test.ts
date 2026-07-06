import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileSystemHtmlStorage } from "./filesystem.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "patchpage-storage-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("FileSystemHtmlStorage", () => {
  it("stores and reads HTML objects", async () => {
    const storage = new FileSystemHtmlStorage(tempDir);

    await storage.putHtmlObject("drafts/abc/versions/one.html", "<h1>hi</h1>");

    await expect(storage.getHtmlObject("drafts/abc/versions/one.html")).resolves.toBe(
      "<h1>hi</h1>"
    );
  });

  it("blocks path traversal", async () => {
    const storage = new FileSystemHtmlStorage(tempDir);

    await expect(storage.putHtmlObject("../escape.html", "<h1>bad</h1>")).rejects.toThrow(
      "escapes"
    );
  });
});
