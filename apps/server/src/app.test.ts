import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getServerConfig } from "@patchpage/config";
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
    const body = upload.json() as { draftId: string; publicUrl: string };
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
