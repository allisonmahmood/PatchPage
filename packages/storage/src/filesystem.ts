import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HtmlStorage } from "./types.js";

export class FileSystemHtmlStorage implements HtmlStorage {
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  async putHtmlObject(key: string, html: string): Promise<void> {
    const filePath = this.resolveKey(key);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, html, "utf8");
  }

  async getHtmlObject(key: string): Promise<string> {
    return readFile(this.resolveKey(key), "utf8");
  }

  private resolveKey(key: string): string {
    if (!key || key.includes("\0")) {
      throw new Error("Invalid storage key.");
    }

    const resolved = path.resolve(this.rootDir, key);
    const relative = path.relative(this.rootDir, resolved);

    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Storage key escapes the configured storage directory.");
    }

    return resolved;
  }
}
