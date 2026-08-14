import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getServerConfig } from "@patchpage/config";
import type { ServerConfig } from "@patchpage/config";
import { JsonFilePatchPageDb } from "@patchpage/db";
import type { RecordUploadInput, RecordUploadResult } from "@patchpage/db";
import { FileSystemHtmlStorage } from "@patchpage/storage";
import { classifyAuthorizationHeader, createApp, isProtectedApiPath } from "./app.js";

let tempDir: string;

const uploadLikeApiTargets: ApiTargetCase[] = [
  {
    label: "trailing slash",
    url: "/api/uploads/"
  },
  {
    label: "duplicate slash",
    url: "/api//uploads"
  },
  {
    label: "encoded slash",
    url: "/api%2Fuploads"
  },
  {
    label: "escaped API prefix",
    url: "/%61pi/uploads/"
  },
  {
    label: "absolute escaped API prefix",
    url: "http://host/%61pi/uploads/",
    rawHttp: true
  },
  {
    label: "unsupported method on exact upload route",
    url: "/api/uploads",
    method: "PUT"
  }
];

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "patchpage-server-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("PatchPage server", () => {
  it("classifies only an absent Authorization header as missing", () => {
    expect(classifyAuthorizationHeader(undefined)).toEqual({ kind: "missing" });
    expect(classifyAuthorizationHeader("")).toEqual({ kind: "invalid" });
    expect(classifyAuthorizationHeader("   ")).toEqual({ kind: "invalid" });
    expect(classifyAuthorizationHeader("Bearer   ")).toEqual({ kind: "invalid" });
    expect(classifyAuthorizationHeader("Bearer dev-token second-token")).toEqual({
      kind: "invalid"
    });
    expect(classifyAuthorizationHeader("Bearer dev-token")).toEqual({
      kind: "bearer",
      token: "dev-token"
    });
    const longPadding = " ".repeat(100_000);
    expect(
      classifyAuthorizationHeader(`bEaReR${longPadding}dev-token${longPadding}`)
    ).toEqual({
      kind: "bearer",
      token: "dev-token"
    });
  });

  it("classifies router-equivalent protected API request targets", () => {
    expect(isProtectedApiPath("/api?ignored=true")).toBe(true);
    expect(isProtectedApiPath("/api#fragment")).toBe(true);
    expect(isProtectedApiPath("/%61pi/does-not-exist")).toBe(true);
    expect(isProtectedApiPath("http://host/api/does-not-exist?ignored=true")).toBe(true);
    expect(isProtectedApiPath("https://host/%61pi/does-not-exist#fragment")).toBe(true);
    expect(isProtectedApiPath("http://host?x=/api/%")).toBe(false);
    expect(isProtectedApiPath("HtTp://host/%61pi/does-not-exist")).toBe(true);
    expect(isProtectedApiPath("/api%2Fdoes-not-exist")).toBe(true);
    expect(isProtectedApiPath("/api//does-not-exist")).toBe(true);
    expect(isProtectedApiPath("/apix")).toBe(false);
    expect(isProtectedApiPath("/%")).toBe(true);
  });

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

  it("creates a server-identified anonymous draft only when explicitly enabled", async () => {
    const config = { ...testConfig(), allowAnonymousUploads: true };
    const db = new JsonFilePatchPageDb(path.join(tempDir, "anonymous-create-db.json"));
    await db.initialize(null);
    const principal = await db.getAnonymousUploadPrincipal();
    const storage = new FileSystemHtmlStorage(
      path.join(tempDir, "anonymous-create-drafts")
    );
    const app = createApp({ config, db, storage });

    const upload = await app.inject({
      method: "POST",
      url: "/api/uploads",
      payload: {
        html: "<!doctype html><html><head><title>Anonymous</title></head><body>anonymous-marker</body></html>"
      }
    });

    expect(upload.statusCode).toBe(201);
    const body = upload.json() as { draftId: string; versionNumber: number };
    expect(body.draftId).toMatch(/^[a-z0-9]{12}$/);
    expect(body.versionNumber).toBe(1);
    const lookup = await db.findDraftVersion(body.draftId);
    expect(lookup.draft?.accountId).toBe(principal.accountId);
    expect(lookup.version?.createdByApiTokenId).toBe(principal.apiTokenId);

    await app.close();
    await db.close();
  });

  it("requires anonymous create requests to omit the draftId property", async () => {
    const config = { ...testConfig(), allowAnonymousUploads: true };
    const db = new JsonFilePatchPageDb(path.join(tempDir, "anonymous-intent-db.json"));
    await db.initialize(null);
    const storage = new FileSystemHtmlStorage(
      path.join(tempDir, "anonymous-intent-drafts")
    );
    const app = createApp({ config, db, storage });
    const html =
      "<!doctype html><html><head><title>Anonymous intent</title></head><body></body></html>";

    for (const draftId of [null, "abcdefghijkl"]) {
      const upload = await app.inject({
        method: "POST",
        url: "/api/uploads",
        payload: { html, draftId }
      });

      expect(upload.statusCode).toBe(400);
      expect(upload.json()).toEqual({
        ok: false,
        error: "Anonymous uploads must omit draftId."
      });
    }

    await app.close();
    await db.close();
  });

  it("does not admit an absent credential on a non-create upload method", async () => {
    const config = { ...testConfig(), allowAnonymousUploads: true };
    const db = new JsonFilePatchPageDb(path.join(tempDir, "anonymous-method-db.json"));
    await db.initialize(null);
    const storage = new FileSystemHtmlStorage(
      path.join(tempDir, "anonymous-method-drafts")
    );
    const app = createApp({ config, db, storage });

    const response = await app.inject({
      method: "PUT",
      url: "/api/uploads",
      headers: { "content-type": "application/json" },
      payload: `{"html":"${"x".repeat(2 * 1024 * 1024)}`
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      ok: false,
      error: "Missing or invalid API token."
    });

    await app.close();
    await db.close();
  });

  it("keeps unmatched upload-like POST targets authenticated and out of anonymous quota", async () => {
    const config = { ...testConfig(), allowAnonymousUploads: true };
    const db = new JsonFilePatchPageDb(path.join(tempDir, "anonymous-route-db.json"));
    await db.initialize(null);
    const originalGetPrincipal = db.getAnonymousUploadPrincipal.bind(db);
    let principalLookups = 0;
    db.getAnonymousUploadPrincipal = async () => {
      principalLookups += 1;
      return originalGetPrincipal();
    };
    const storage = new FileSystemHtmlStorage(
      path.join(tempDir, "anonymous-route-drafts")
    );
    const app = createApp({ config, db, storage });

    try {
      for (const target of uploadLikeApiTargets.slice(0, 5)) {
        const response = target.rawHttp
          ? await rawHttpRequest(app, target.url)
          : await app.inject({
              method: "POST",
              url: target.url,
              payload: {}
            });
        expect(response.statusCode, target.label).toBe(401);
        expect(response.json(), target.label).toEqual({
          ok: false,
          error: "Missing or invalid API token."
        });
      }
      expect(principalLookups).toBe(0);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/api/uploads",
          payload: {}
        });
        expect(response.statusCode).toBe(400);
      }
      expect(principalLookups).toBe(5);

      const limited = await app.inject({
        method: "POST",
        url: "/api/uploads",
        payload: {}
      });
      expect(limited.statusCode).toBe(429);
      expect(principalLookups).toBe(5);
    } finally {
      await app.close();
      await db.close();
    }
  });

  it("allows admin credentials alone to moderate anonymous drafts", async () => {
    const config = { ...testConfig(), allowAnonymousUploads: true };
    const db = new JsonFilePatchPageDb(path.join(tempDir, "anonymous-moderation-db.json"));
    await db.initialize("admin-token");
    const admin = await db.findApiTokenByToken("admin-token");
    if (!admin) throw new Error("Expected bootstrap authentication.");
    await db.createApiToken({
      accountId: admin.accountId,
      name: "Ordinary token",
      token: "ordinary-token",
      scopes: ["upload"]
    });
    const storage = new FileSystemHtmlStorage(
      path.join(tempDir, "anonymous-moderation-drafts")
    );
    const app = createApp({ config, db, storage });
    const createAnonymous = () =>
      app.inject({
        method: "POST",
        url: "/api/uploads",
        payload: {
          html: "<!doctype html><html><head><title>Moderate me</title></head><body></body></html>"
        }
      });

    try {
      const disableTarget = await createAnonymous();
      const disableDraftId = (disableTarget.json() as { draftId: string }).draftId;
      for (const request of [
        { method: "GET" as const, url: "/api/me" },
        { method: "GET" as const, url: "/api/drafts" },
        {
          method: "POST" as const,
          url: `/api/drafts/${disableDraftId}/disable`,
          payload: { reason: "anonymous attempt" }
        },
        { method: "DELETE" as const, url: `/api/drafts/${disableDraftId}` }
      ]) {
        const anonymousOperation = await app.inject(request);
        expect(anonymousOperation.statusCode).toBe(401);
      }

      const ordinaryDisable = await app.inject({
        method: "POST",
        url: `/api/drafts/${disableDraftId}/disable`,
        headers: { authorization: "Bearer ordinary-token" },
        payload: { reason: "not an admin" }
      });
      expect(ordinaryDisable.statusCode).toBe(404);

      const adminDisable = await app.inject({
        method: "POST",
        url: `/api/drafts/${disableDraftId}/disable`,
        headers: { authorization: "Bearer admin-token" },
        payload: { reason: "admin policy" }
      });
      expect(adminDisable.statusCode).toBe(200);

      const deleteTarget = await createAnonymous();
      const deleteDraftId = (deleteTarget.json() as { draftId: string }).draftId;
      const ordinaryDelete = await app.inject({
        method: "DELETE",
        url: `/api/drafts/${deleteDraftId}`,
        headers: { authorization: "Bearer ordinary-token" }
      });
      expect(ordinaryDelete.statusCode).toBe(404);

      const adminDelete = await app.inject({
        method: "DELETE",
        url: `/api/drafts/${deleteDraftId}`,
        headers: { authorization: "Bearer admin-token" }
      });
      expect(adminDelete.statusCode).toBe(200);

      const foreignDraftId = "zzzzzzzzzzzz";
      await db.recordUpload({
        intent: "create",
        draftId: foreignDraftId,
        versionId: "ver_foreign_owner",
        accountId: "acct_foreign",
        apiTokenId: admin.id,
        title: "Foreign ordinary draft",
        objectKey: `drafts/${foreignDraftId}/versions/ver_foreign_owner.html`,
        contentHash: "sha256:foreign",
        fileSize: 1,
        filename: "foreign.html",
        metadata: {},
        sourceIp: null,
        userAgent: "vitest"
      });
      const crossAccountAdmin = await app.inject({
        method: "DELETE",
        url: `/api/drafts/${foreignDraftId}`,
        headers: { authorization: "Bearer admin-token" }
      });
      expect(crossAccountAdmin.statusCode).toBe(404);
    } finally {
      await app.close();
      await db.close();
    }
  });

  it("does not downgrade present bad credentials when anonymous uploads are enabled", async () => {
    const config = { ...testConfig(), allowAnonymousUploads: true };
    const dbFile = path.join(tempDir, "pre-body-auth-db.json");
    const db = new JsonFilePatchPageDb(dbFile);
    await db.initialize("admin-token");
    const adminAuth = await db.findApiTokenByToken("admin-token");
    expect(adminAuth).not.toBeNull();
    await db.createApiToken({
      accountId: adminAuth!.accountId,
      name: "Read-only token",
      token: "read-token",
      scopes: ["read"]
    });
    await db.createApiToken({
      accountId: adminAuth!.accountId,
      name: "Revoked token",
      token: "revoked-token",
      scopes: ["upload"]
    });
    await markJsonTokenRevoked(dbFile, "Revoked token");

    const storage = new FileSystemHtmlStorage(path.join(tempDir, "pre-body-auth-drafts"));
    const app = createApp({ config, db, storage });
    const attackerJson = `{"html":"${"x".repeat(2 * 1024 * 1024)}`;

    try {
      const cases = [
        {
          label: "empty",
          authorization: "",
          statusCode: 401,
          error: "Missing or invalid API token."
        },
        {
          label: "whitespace",
          authorization: "   ",
          statusCode: 401,
          error: "Missing or invalid API token."
        },
        {
          label: "malformed",
          authorization: "Basic not-a-bearer-token",
          statusCode: 401,
          error: "Missing or invalid API token."
        },
        {
          label: "unknown",
          authorization: "Bearer unknown-token",
          statusCode: 401,
          error: "Missing or invalid API token."
        },
        {
          label: "revoked",
          authorization: "Bearer revoked-token",
          statusCode: 401,
          error: "Missing or invalid API token."
        },
        {
          label: "insufficient-scope",
          authorization: "Bearer read-token",
          statusCode: 403,
          error: "API token does not have the required scope."
        }
      ];

      for (const testCase of cases) {
        const response = await app.inject({
          method: "POST",
          url: "/api/uploads",
          headers: {
            "content-type": "application/json",
            ...(testCase.authorization !== undefined
              ? { authorization: testCase.authorization }
              : {})
          },
          payload: attackerJson
        });

        expect(response.statusCode, testCase.label).toBe(testCase.statusCode);
        expect(response.json(), testCase.label).toEqual({
          ok: false,
          error: testCase.error
        });
      }

      const anonymousAfterBadCredentials = await app.inject({
        method: "POST",
        url: "/api/uploads",
        payload: {
          html: "<!doctype html><html><head><title>Anonymous quota remains</title></head><body></body></html>"
        }
      });
      expect(anonymousAfterBadCredentials.statusCode).toBe(201);
    } finally {
      await app.close();
      await db.close();
    }
  });

  it.each(uploadLikeApiTargets)(
    "rejects insufficient upload scope before parsing upload-like target: $label",
    async (target) => {
      const { app, db } = await createScopedTokenApp(`insufficient-${target.label}`);

      try {
        const response = await oversizedJsonApiRequest(app, {
          target,
          token: "read-token"
        });

        expect(response.statusCode).toBe(403);
        expect(response.json()).toEqual({
          ok: false,
          error: "API token does not have the required scope."
        });
      } finally {
        await app.close();
        await db.close();
      }
    }
  );

  it.each(uploadLikeApiTargets)(
    "returns API 404 before parsing authorized upload-like unmatched target: $label",
    async (target) => {
      const { app, db } = await createScopedTokenApp(`authorized-${target.label}`);

      try {
        const response = await oversizedJsonApiRequest(app, {
          target,
          token: "upload-token"
        });

        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({
          ok: false,
          error: "Not found."
        });
      } finally {
        await app.close();
        await db.close();
      }
    }
  );

  it("allows admin scope to satisfy upload-like policy before unmatched API 404", async () => {
    const { app, db } = await createScopedTokenApp("authorized-admin-upload-like");

    try {
      const response = await oversizedJsonApiRequest(app, {
        target: uploadLikeApiTargets[0],
        token: "admin-only-token"
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        ok: false,
        error: "Not found."
      });
    } finally {
      await app.close();
      await db.close();
    }
  });

  it("returns API 404 before parsing arbitrary authenticated unmatched API targets", async () => {
    const { app, db } = await createScopedTokenApp("authorized-arbitrary-unmatched-api");

    try {
      const response = await oversizedJsonApiRequest(app, {
        target: {
          label: "arbitrary unmatched API",
          url: "/api/does-not-exist"
        },
        token: "read-token"
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        ok: false,
        error: "Not found."
      });
    } finally {
      await app.close();
      await db.close();
    }
  });

  it("limits authorized upload-like unmatched targets by stable token identity", async () => {
    let now = 1_000;
    const { app, db } = await createScopedTokenApp("upload-like-unmatched-limit", () => now);
    const target: ApiTargetCase = {
      label: "encoded slash upload-like target",
      url: "/api%2Fuploads"
    };

    try {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const response = await app.inject({
          method: "POST",
          url: target.url,
          headers: { authorization: "Bearer upload-token" }
        });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({
          ok: false,
          error: "Not found."
        });
      }

      const limited = await app.inject({
        method: "POST",
        url: target.url,
        headers: { authorization: "Bearer upload-token" }
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBe("60");
      expect(Number.isInteger(Number(limited.headers["retry-after"]))).toBe(true);
      expect(limited.json()).toEqual({
        ok: false,
        error: "Rate limit exceeded.",
        code: "rate_limited",
        retryAfterSeconds: 60
      });

      now = 61_000;
      const reset = await app.inject({
        method: "POST",
        url: target.url,
        headers: { authorization: "Bearer upload-token" }
      });
      expect(reset.statusCode).toBe(404);
    } finally {
      await app.close();
      await db.close();
    }
  });

  it("limits protected API attempts by canonical request IP", async () => {
    let now = 1_000;
    const config = getServerConfig({ PATCHPAGE_TRUST_PROXY: "1" });
    const db = new JsonFilePatchPageDb(path.join(tempDir, "protected-limit-db.json"));
    await db.initialize("unused-token");
    const storage = new FileSystemHtmlStorage(path.join(tempDir, "protected-limit-drafts"));
    const app = createApp({ config, db, storage, clock: () => now });

    try {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const response = await app.inject({
          method: "GET",
          url: "/api/me",
          remoteAddress: "10.0.0.5",
          headers: { "x-forwarded-for": "203.0.113.9" }
        });

        expect(response.statusCode).toBe(401);
      }

      const limited = await app.inject({
        method: "GET",
        url: "/api/me",
        remoteAddress: "10.0.0.5",
        headers: { "x-forwarded-for": "203.0.113.9" }
      });

      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBe("60");
      expect(Number.isInteger(Number(limited.headers["retry-after"]))).toBe(true);
      expect(limited.json()).toEqual({
        ok: false,
        error: "Rate limit exceeded.",
        code: "rate_limited",
        retryAfterSeconds: 60
      });

      const otherIp = await app.inject({
        method: "GET",
        url: "/api/me",
        remoteAddress: "10.0.0.5",
        headers: { "x-forwarded-for": "203.0.113.10" }
      });
      expect(otherIp.statusCode).toBe(401);

      const health = await app.inject({
        method: "GET",
        url: "/healthz",
        remoteAddress: "10.0.0.5",
        headers: { "x-forwarded-for": "203.0.113.9" }
      });
      expect(health.statusCode).toBe(200);

      now = 61_000;
      const reset = await app.inject({
        method: "GET",
        url: "/api/me",
        remoteAddress: "10.0.0.5",
        headers: { "x-forwarded-for": "203.0.113.9" }
      });
      expect(reset.statusCode).toBe(401);
    } finally {
      await app.close();
      await db.close();
    }
  });

  it("protects unmatched API paths before parsing and counts them once per IP", async () => {
    let now = 1_000;
    const config = testConfig();
    const db = new JsonFilePatchPageDb(path.join(tempDir, "unmatched-api-limit-db.json"));
    await db.initialize("dev-token");
    const storage = new FileSystemHtmlStorage(path.join(tempDir, "unmatched-api-limit-drafts"));
    const app = createApp({ config, db, storage, clock: () => now });

    try {
      const upload = await app.inject({
        method: "POST",
        url: "/api/uploads",
        remoteAddress: "198.51.100.10",
        headers: { authorization: "Bearer dev-token" },
        payload: {
          html: "<!doctype html><html><head><title>Public Draft</title></head><body></body></html>"
        }
      });
      expect(upload.statusCode).toBe(201);
      const { draftId } = upload.json() as { draftId: string };

      const attackerJson = `{"html":"${"x".repeat(2 * 1024 * 1024)}`;
      const oversized = await app.inject({
        method: "POST",
        url: "/api/does-not-exist",
        remoteAddress: "203.0.113.9",
        headers: { "content-type": "application/json" },
        payload: attackerJson
      });
      expect(oversized.statusCode).toBe(401);
      expect(oversized.json()).toEqual({
        ok: false,
        error: "Missing or invalid API token."
      });

      for (let attempt = 1; attempt < 60; attempt += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/api/does-not-exist",
          remoteAddress: "203.0.113.9"
        });
        expect(response.statusCode).toBe(401);
      }

      const limited = await app.inject({
        method: "POST",
        url: "/api/does-not-exist",
        remoteAddress: "203.0.113.9"
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBe("60");
      expect(limited.json()).toEqual({
        ok: false,
        error: "Rate limit exceeded.",
        code: "rate_limited",
        retryAfterSeconds: 60
      });

      const lookalike = await app.inject({
        method: "GET",
        url: "/apix",
        remoteAddress: "203.0.113.9"
      });
      expect(lookalike.statusCode).toBe(404);

      const health = await app.inject({
        method: "GET",
        url: "/healthz",
        remoteAddress: "203.0.113.9"
      });
      expect(health.statusCode).toBe(200);

      const viewer = await app.inject({
        method: "GET",
        url: `/d/${draftId}`,
        remoteAddress: "203.0.113.9"
      });
      expect(viewer.statusCode).toBe(200);
      expect(viewer.body).toContain("Public Draft");

      now = 61_000;
      const reset = await app.inject({
        method: "POST",
        url: "/api/does-not-exist",
        remoteAddress: "203.0.113.9"
      });
      expect(reset.statusCode).toBe(401);
    } finally {
      await app.close();
      await db.close();
    }
  });

  it.each([
    {
      label: "origin-form escaped API prefix",
      url: "/%61pi/does-not-exist",
      rawHttp: false
    },
    {
      label: "absolute-form API target",
      url: "http://host/api/does-not-exist",
      rawHttp: true
    },
    {
      label: "mixed-case absolute-form API target",
      url: "HtTp://host/%61pi/does-not-exist",
      rawHttp: true
    }
  ])(
    "protects router-equivalent unmatched API target before parsing and counts it once per IP: $label",
    async ({ rawHttp, url }) => {
      let now = 1_000;
      const config = testConfig();
      const db = new JsonFilePatchPageDb(path.join(tempDir, `${url.replaceAll(/[^a-z0-9]/gi, "-")}-db.json`));
      await db.initialize("dev-token");
      const storage = new FileSystemHtmlStorage(
        path.join(tempDir, `${url.replaceAll(/[^a-z0-9]/gi, "-")}-drafts`)
      );
      const app = createApp({ config, db, storage, clock: () => now });

      try {
        const attackerJson = `{"html":"${"x".repeat(2 * 1024 * 1024)}`;
        const oversized = rawHttp
          ? await rawHttpRequest(
              app,
              url,
              "{\"html\":\"",
              {
                "Content-Type": "application/json",
                "Content-Length": String(2 * 1024 * 1024 + 1)
              },
              { closeAfterWrite: false }
            )
          : await app.inject({
              method: "POST",
              url,
              remoteAddress: "203.0.113.9",
              headers: { "content-type": "application/json" },
              payload: attackerJson
            });
        expect(oversized.statusCode).toBe(401);
        expect(oversized.json()).toEqual({
          ok: false,
          error: "Missing or invalid API token."
        });

        for (let attempt = 1; attempt < 60; attempt += 1) {
          const response = rawHttp
            ? await rawHttpRequest(app, url)
            : await app.inject({
                method: "POST",
                url,
                remoteAddress: "203.0.113.9"
              });
          expect(response.statusCode).toBe(401);
        }

        const limited = rawHttp
          ? await rawHttpRequest(app, url)
          : await app.inject({
              method: "POST",
              url,
              remoteAddress: "203.0.113.9"
            });
        expect(limited.statusCode).toBe(429);
        expect(limited.headers["retry-after"]).toBe("60");
        expect(Number.isInteger(Number(limited.headers["retry-after"]))).toBe(true);
        expect(limited.json()).toEqual({
          ok: false,
          error: "Rate limit exceeded.",
          code: "rate_limited",
          retryAfterSeconds: 60
        });

        const health = await app.inject({
          method: "GET",
          url: "/healthz",
          remoteAddress: "203.0.113.9"
        });
        expect(health.statusCode).toBe(200);

        now = 61_000;
        const reset = rawHttp
          ? await rawHttpRequest(app, url)
          : await app.inject({
              method: "POST",
              url,
              remoteAddress: "203.0.113.9"
            });
        expect(reset.statusCode).toBe(401);
      } finally {
        await app.close();
        await db.close();
      }
    }
  );

  it.each([
    {
      label: "malformed percent escape",
      protectedTarget: "/api/%",
      authenticatedStatus: 400,
      authenticatedError: "Malformed request target."
    },
    {
      label: "escaped-prefix malformed percent escape",
      protectedTarget: "HtTp://host/%61pi/%",
      authenticatedStatus: 400,
      authenticatedError: "Malformed request target."
    },
    {
      label: "overlong route parameter",
      protectedTarget: `/api/drafts/${"x".repeat(101)}/disable`,
      authenticatedStatus: 414,
      authenticatedError: "Request target is too long."
    },
    {
      label: "encoded overlong route parameter",
      protectedTarget: `/api/drafts/${"x".repeat(60)}%2F${"x".repeat(60)}/disable`,
      authenticatedStatus: 414,
      authenticatedError: "Request target is too long."
    },
    {
      label: "DELETE overlong route parameter",
      protectedTarget: `/api/drafts/${"x".repeat(101)}`,
      method: "DELETE",
      authenticatedStatus: 414,
      authenticatedError: "Request target is too long."
    }
  ])(
    "authenticates and limits pre-routing API failure: $label",
    async ({
      label,
      protectedTarget,
      method,
      authenticatedStatus,
      authenticatedError
    }) => {
      let now = 1_000;
      const config = testConfig();
      const caseName = label.replaceAll(/[^a-z0-9]/gi, "-");
      const db = new JsonFilePatchPageDb(
        path.join(tempDir, `${caseName}-pre-routing-db.json`)
      );
      await db.initialize("dev-token");
      const storage = new FileSystemHtmlStorage(
        path.join(tempDir, `${caseName}-pre-routing-drafts`)
      );
      const app = createApp({ config, db, storage, clock: () => now });

      try {
        const publicMalformed = await rawHttpRequest(app, "/public/%");
        expect(publicMalformed.statusCode).toBe(400);

        for (let attempt = 1; attempt <= 60; attempt += 1) {
          const response = await rawHttpRequest(
            app,
            protectedTarget,
            "",
            {},
            { method }
          );
          expect(response.statusCode).toBe(401);
          expect(response.json()).toEqual({
            ok: false,
            error: "Missing or invalid API token."
          });
        }

        const limited = await rawHttpRequest(
          app,
          protectedTarget,
          "",
          {},
          { method }
        );
        expect(limited.statusCode).toBe(429);
        expect(limited.headers["retry-after"]).toBe("60");
        expect(limited.json()).toEqual({
          ok: false,
          error: "Rate limit exceeded.",
          code: "rate_limited",
          retryAfterSeconds: 60
        });

        now = 61_000;
        const authenticated = await rawHttpRequest(
          app,
          protectedTarget,
          "",
          { Authorization: "Bearer dev-token" },
          { closeAfterWrite: false, method }
        );
        expect(authenticated.statusCode).toBe(authenticatedStatus);
        expect(authenticated.json()).toEqual({
          ok: false,
          error: authenticatedError
        });
      } finally {
        await app.close();
        await db.close();
      }
    }
  );

  it("preserves authenticated 404s for long unmatched API route shapes", async () => {
    const config = testConfig();
    const db = new JsonFilePatchPageDb(path.join(tempDir, "long-unmatched-api-db.json"));
    await db.initialize("dev-token");
    const storage = new FileSystemHtmlStorage(
      path.join(tempDir, "long-unmatched-api-drafts")
    );
    const app = createApp({ config, db, storage });
    const longSegment = "x".repeat(101);

    try {
      for (const { method, requestTarget } of [
        { method: "POST", requestTarget: `/api/unmatched/${longSegment}` },
        {
          method: "POST",
          requestTarget: `/api/drafts/${longSegment}`
        },
        {
          method: "DELETE",
          requestTarget: `/api/drafts/${longSegment}/disable`
        },
        {
          method: "PUT",
          requestTarget: `/api/drafts/${longSegment}/disable`
        }
      ]) {
        const response = await rawHttpRequest(
          app,
          requestTarget,
          "",
          { Authorization: "Bearer dev-token" },
          { closeAfterWrite: false, method }
        );
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ ok: false, error: "Not found." });
      }
    } finally {
      await app.close();
      await db.close();
    }
  });

  it("does not classify an absolute URI query as an API path or consume its bucket", async () => {
    const config = testConfig();
    const db = new JsonFilePatchPageDb(path.join(tempDir, "absolute-query-db.json"));
    await db.initialize("dev-token");
    const storage = new FileSystemHtmlStorage(path.join(tempDir, "absolute-query-drafts"));
    const app = createApp({ config, db, storage });

    try {
      const publicQuery = await rawHttpRequest(app, "http://host?x=/api/%");
      expect(publicQuery.statusCode).toBe(400);

      for (let attempt = 1; attempt <= 60; attempt += 1) {
        const response = await rawHttpRequest(app, "/api/does-not-exist");
        expect(response.statusCode).toBe(401);
      }

      const limited = await rawHttpRequest(app, "/api/does-not-exist");
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBe("60");
    } finally {
      await app.close();
      await db.close();
    }
  });

  it("limits authenticated upload attempts by stable token identity", async () => {
    let now = 1_000;
    const config = testConfig();
    const db = new JsonFilePatchPageDb(path.join(tempDir, "upload-limit-db.json"));
    await db.initialize("upload-token");
    const auth = await db.findApiTokenByToken("upload-token");
    expect(auth).not.toBeNull();
    await db.createApiToken({
      accountId: auth!.accountId,
      name: "Other upload token",
      token: "other-upload-token",
      scopes: ["upload"]
    });
    const storage = new FileSystemHtmlStorage(path.join(tempDir, "upload-limit-drafts"));
    const app = createApp({ config, db, storage, clock: () => now });

    try {
      const upload = await app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { authorization: "Bearer upload-token" },
        payload: {
          html: "<!doctype html><html><head><title>Limited Draft</title></head><body><h1>Hello</h1></body></html>"
        }
      });
      expect(upload.statusCode).toBe(201);
      const { draftId } = upload.json() as { draftId: string };

      for (let attempt = 0; attempt < 9; attempt += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/api/uploads",
          headers: { authorization: "Bearer upload-token" },
          payload: {}
        });
        expect(response.statusCode).toBe(400);
      }

      await db.initialize("rotated-upload-token");

      for (let attempt = 0; attempt < 10; attempt += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/api/uploads",
          headers: { authorization: "Bearer rotated-upload-token" },
          payload: {}
        });
        expect(response.statusCode).toBe(400);
      }

      const limited = await app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { authorization: "Bearer rotated-upload-token" },
        payload: {}
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBe("60");
      expect(limited.json()).toEqual({
        ok: false,
        error: "Rate limit exceeded.",
        code: "rate_limited",
        retryAfterSeconds: 60
      });

      const otherToken = await app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { authorization: "Bearer other-upload-token" },
        payload: {}
      });
      expect(otherToken.statusCode).toBe(400);

      const viewer = await app.inject({ method: "GET", url: `/d/${draftId}` });
      expect(viewer.statusCode).toBe(200);
      expect(viewer.body).toContain("Limited Draft");

      now = 61_000;
      const reset = await app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { authorization: "Bearer rotated-upload-token" },
        payload: {}
      });
      expect(reset.statusCode).toBe(400);
    } finally {
      await app.close();
      await db.close();
    }
  });

  it("composes protected, anonymous-create, and token upload limits independently", async () => {
    let now = 1_000;
    const config = {
      ...testConfig(),
      allowAnonymousUploads: true,
      protectedApiRateLimitPerMinute: 8,
      authenticatedUploadRateLimitPerMinute: 1,
      anonymousCreateRateLimitPerMinute: 5
    };
    const db = new JsonFilePatchPageDb(path.join(tempDir, "anonymous-limit-db.json"));
    await db.initialize("upload-token");
    const storage = new FileSystemHtmlStorage(
      path.join(tempDir, "anonymous-limit-drafts")
    );
    const app = createApp({ config, db, storage, clock: () => now });

    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/api/uploads",
          payload: {}
        });
        expect(response.statusCode).toBe(400);
      }

      const anonymousLimited = await app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { "content-type": "application/json" },
        payload: `{"html":"${"x".repeat(2 * 1024 * 1024)}`
      });
      expect(anonymousLimited.statusCode).toBe(429);
      expect(anonymousLimited.headers["retry-after"]).toBe("60");

      const authenticated = await app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { authorization: "Bearer upload-token" },
        payload: {
          html: "<!doctype html><html><head><title>Authenticated quota</title></head><body></body></html>"
        }
      });
      expect(authenticated.statusCode).toBe(201);

      const tokenLimited = await app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { authorization: "Bearer upload-token" },
        payload: {}
      });
      expect(tokenLimited.statusCode).toBe(429);

      const protectedLimited = await app.inject({
        method: "GET",
        url: "/api/me",
        headers: { authorization: "Bearer upload-token" }
      });
      expect(protectedLimited.statusCode).toBe(429);

      now = 61_000;
      const resetAnonymous = await app.inject({
        method: "POST",
        url: "/api/uploads",
        payload: {
          html: "<!doctype html><html><head><title>Reset anonymous</title></head><body></body></html>"
        }
      });
      expect(resetAnonymous.statusCode).toBe(201);

      const resetAuthenticated = await app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { authorization: "Bearer upload-token" },
        payload: {
          html: "<!doctype html><html><head><title>Reset token</title></head><body></body></html>"
        }
      });
      expect(resetAuthenticated.statusCode).toBe(201);
    } finally {
      await app.close();
      await db.close();
    }
  });

  it("limits draft creates per minute per token without counting updates", async () => {
    let now = 1_000;
    const config = { ...testConfig(), draftCreateRateLimitPerMinute: 2 };
    const db = new JsonFilePatchPageDb(path.join(tempDir, "create-limit-db.json"));
    await db.initialize("dev-token");
    const storage = new FileSystemHtmlStorage(path.join(tempDir, "create-limit-drafts"));
    const app = createApp({ config, db, storage, clock: () => now });

    try {
      const first = await createDraft(app, "dev-token", "First");
      expect(first.statusCode).toBe(201);
      const { draftId } = first.json() as { draftId: string };

      // Updates in the same window must not spend any of the create budget.
      for (let revision = 0; revision < 3; revision += 1) {
        const update = await updateDraft(app, "dev-token", draftId, `First v${revision}`);
        expect(update.statusCode).toBe(200);
      }

      // Still room for the window's second create, so the updates cost nothing.
      expect((await createDraft(app, "dev-token", "Second")).statusCode).toBe(201);

      const limited = await createDraft(app, "dev-token", "Third");
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBe("60");
      expect(limited.json()).toEqual({
        ok: false,
        error: "Rate limit exceeded.",
        code: "rate_limited",
        retryAfterSeconds: 60
      });

      // An update still succeeds once the create bucket is empty.
      expect(
        (await updateDraft(app, "dev-token", draftId, "First again")).statusCode
      ).toBe(200);

      now = 61_000;
      const afterWindow = await createDraft(app, "dev-token", "Fourth");
      expect(afterWindow.statusCode).toBe(201);
    } finally {
      await app.close();
      await db.close();
    }
  });

  it("caps live drafts per token from the database, across a restart", async () => {
    const config = { ...testConfig(), liveDraftsPerToken: 2 };
    const dbFile = path.join(tempDir, "live-cap-db.json");
    const storage = new FileSystemHtmlStorage(path.join(tempDir, "live-cap-drafts"));
    // `dev-token` is the admin bootstrap token: the cap has no admin exemption.
    const db = new JsonFilePatchPageDb(dbFile);
    await db.initialize("dev-token");
    const app = createApp({ config, db, storage });

    try {
      const one = await createDraft(app, "dev-token", "One");
      expect(one.statusCode).toBe(201);
      const { draftId } = one.json() as { draftId: string };
      expect((await createDraft(app, "dev-token", "Two")).statusCode).toBe(201);

      const overQuota = await createDraft(app, "dev-token", "Three");
      expect(overQuota.statusCode).toBe(403);
      expect(overQuota.json()).toEqual({
        ok: false,
        error:
          "Draft quota reached: 2 live drafts per token. Delete or let a draft expire before creating another.",
        code: "live_draft_quota_exceeded",
        quota: 2
      });

      // The quota bounds creates only: at the ceiling, rewriting a draft the
      // token already holds still succeeds.
      expect(
        (await updateDraft(app, "dev-token", draftId, "One revised")).statusCode
      ).toBe(200);
    } finally {
      await app.close();
      await db.close();
    }

    // A restart drops every in-memory bucket. The cap is recounted from the
    // database, so it is still there.
    const restartedDb = new JsonFilePatchPageDb(dbFile);
    await restartedDb.initialize("dev-token");
    const restarted = createApp({ config, db: restartedDb, storage });

    try {
      const stillOverQuota = await createDraft(restarted, "dev-token", "Three again");
      expect(stillOverQuota.statusCode).toBe(403);
      expect(stillOverQuota.json()).toMatchObject({
        code: "live_draft_quota_exceeded",
        quota: 2
      });
    } finally {
      await restarted.close();
      await restartedDb.close();
    }
  });

  it("returns live-draft cap room when a draft is disabled or deleted", async () => {
    const config = { ...testConfig(), liveDraftsPerToken: 1 };
    const db = new JsonFilePatchPageDb(path.join(tempDir, "live-cap-release-db.json"));
    await db.initialize("dev-token");
    const auth = await db.findApiTokenByToken("dev-token");
    expect(auth).not.toBeNull();
    await db.createApiToken({
      accountId: auth!.accountId,
      name: "Sibling upload token",
      token: "sibling-token",
      scopes: ["upload"]
    });
    const storage = new FileSystemHtmlStorage(
      path.join(tempDir, "live-cap-release-drafts")
    );
    const app = createApp({ config, db, storage });

    try {
      const created = await createDraft(app, "dev-token", "Only one");
      expect(created.statusCode).toBe(201);
      const { draftId } = created.json() as { draftId: string };
      expect((await createDraft(app, "dev-token", "Blocked")).statusCode).toBe(403);

      // The cap is per token, not per account: a sibling token on the same
      // account still has its own room.
      expect((await createDraft(app, "sibling-token", "Sibling")).statusCode).toBe(201);

      const disable = await app.inject({
        method: "POST",
        url: `/api/drafts/${draftId}/disable`,
        headers: { authorization: "Bearer dev-token" },
        payload: { reason: "quota test" }
      });
      expect(disable.statusCode).toBe(200);

      const afterDisable = await createDraft(app, "dev-token", "After disable");
      expect(afterDisable.statusCode).toBe(201);
      const replacementDraftId = (afterDisable.json() as { draftId: string }).draftId;
      expect((await createDraft(app, "dev-token", "Blocked again")).statusCode).toBe(403);

      const removed = await app.inject({
        method: "DELETE",
        url: `/api/drafts/${replacementDraftId}`,
        headers: { authorization: "Bearer dev-token" }
      });
      expect(removed.statusCode).toBe(200);

      expect((await createDraft(app, "dev-token", "After delete")).statusCode).toBe(201);
      // Nothing the first token did moved the sibling's own tally.
      expect((await createDraft(app, "sibling-token", "Sibling blocked")).statusCode).toBe(
        403
      );
    } finally {
      await app.close();
      await db.close();
    }
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

  it("serves drafts noindexed, unwatched, and open to machines", async () => {
    const served = await createServedDraft("serving-guarantees");

    for (const url of [served.latestUrl, served.versionUrl]) {
      const anonymous = await served.app.inject({ method: "GET", url });
      expect(anonymous.statusCode).toBe(200);
      expect(anonymous.headers["x-robots-tag"]).toBe("noindex");
      expect(anonymous.headers["set-cookie"]).toBeUndefined();
      expect(anonymous.headers["www-authenticate"]).toBeUndefined();
      expect(anonymous.body).toContain("Serving Guarantees");
    }

    // No auth or session on the serving host: reader credentials are neither
    // required nor consulted, and a bad one never turns into a challenge.
    const credentialed = await served.app.inject({
      method: "GET",
      url: served.latestUrl,
      headers: { authorization: "Bearer not-a-real-token", cookie: "session=whatever" }
    });
    expect(credentialed.statusCode).toBe(200);
    expect(credentialed.headers["set-cookie"]).toBeUndefined();
    expect(credentialed.headers["www-authenticate"]).toBeUndefined();
    expect(credentialed.body).toContain("Serving Guarantees");

    const missing = await served.app.inject({ method: "GET", url: "/d/doesnotexist1" });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers["x-robots-tag"]).toBe("noindex");
    expect(missing.headers["set-cookie"]).toBeUndefined();

    await served.close();
  });

  it("caches version URLs immutably, latest-draft URLs briefly, and everything else never", async () => {
    const served = await createServedDraft("serving-cache-headers");

    const latest = await served.app.inject({ method: "GET", url: served.latestUrl });
    expect(latest.statusCode).toBe(200);
    expect(latest.headers["cache-control"]).toBe("public, max-age=60");

    const version = await served.app.inject({ method: "GET", url: served.versionUrl });
    expect(version.statusCode).toBe(200);
    expect(version.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

    const missingVersion = await served.app.inject({
      method: "GET",
      url: `/d/${served.draftId}/v/9`
    });
    expect(missingVersion.statusCode).toBe(404);
    expect(missingVersion.headers["cache-control"]).toBe("no-store");

    const missingDraft = await served.app.inject({ method: "GET", url: "/d/doesnotexist1" });
    expect(missingDraft.statusCode).toBe(404);
    expect(missingDraft.headers["cache-control"]).toBe("no-store");

    // Everything that is not a served draft — API routes included — stays uncached.
    const uncachedResponses = [
      await served.app.inject({
        method: "GET",
        url: "/api/me",
        headers: { authorization: "Bearer dev-token" }
      }),
      await served.app.inject({ method: "GET", url: "/api/me" }),
      await served.app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { authorization: "Bearer dev-token" },
        payload: { html: "<!doctype html><html><head><title>Second</title></head><body></body></html>" }
      }),
      await served.app.inject({ method: "GET", url: "/healthz" }),
      await served.app.inject({ method: "GET", url: "/" })
    ];
    for (const response of uncachedResponses) {
      expect(response.headers["cache-control"]).toBe("no-store");
    }

    await served.close();
  });

  it("locks the draft content security policy with no script sources", async () => {
    const served = await createServedDraft("serving-csp");

    for (const url of [served.latestUrl, served.versionUrl]) {
      const response = await served.app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-security-policy"]).toBe(
        "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; " +
          "frame-src 'self' about:; base-uri 'none'; form-action 'none'"
      );
      expect(response.headers["content-security-policy"]).not.toContain("script");
      expect(response.body).not.toContain("<script");
    }

    await served.close();
  });

  it("stops serving and stops updating a draft once its retention clock runs out", async () => {
    const clocked = await createClockedApp("expiry");

    try {
      const draftId = await publishDraft(clocked.app, "Ninety day page");

      // A visit this early tops up nothing, so the clock still ends at day 90.
      clocked.advanceDays(1);
      const early = await clocked.app.inject({ method: "GET", url: `/d/${draftId}` });
      expect(early.statusCode).toBe(200);
      expect(early.body).toContain("Ninety day page");

      clocked.advanceDays(90);
      for (const url of [`/d/${draftId}`, `/d/${draftId}/v/1`]) {
        const gone = await clocked.app.inject({ method: "GET", url });
        expect(gone.statusCode).toBe(404);
        expect(gone.headers["content-type"]).toContain("text/html");
        expect(gone.body).not.toContain("Ninety day page");

        // An expired draft's 404 is an ordinary draft-URL 404 and carries the
        // same serving guarantees: still noindexed, and never cached — the page
        // it replaced was cacheable, and this must not inherit that.
        expect(gone.headers["x-robots-tag"]).toBe("noindex");
        expect(gone.headers["cache-control"]).toBe("no-store");
        expect(gone.headers["set-cookie"]).toBeUndefined();
      }

      const update = await clocked.app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { authorization: "Bearer dev-token" },
        payload: {
          draftId,
          html: "<!doctype html><html><head><title>Too late</title></head><body></body></html>"
        }
      });
      expect(update.statusCode).toBe(404);
      expect(update.json()).toEqual({ ok: false, error: "Draft not found." });
    } finally {
      await clocked.close();
    }
  });

  it("keeps a visited draft alive, and lets it go once the visits stop", async () => {
    const clocked = await createClockedApp("visit-topup");

    try {
      const draftId = await publishDraft(clocked.app, "Still visited");

      // Ten days left on the upload's window: this visit tops it up to thirty.
      clocked.advanceDays(80);
      const inWindow = await clocked.app.inject({ method: "GET", url: `/d/${draftId}` });
      expect(inWindow.statusCode).toBe(200);

      // Day 95 — past where the upload alone would have ended it. The page is
      // still here because it was visited, and this visit extends it again.
      clocked.advanceDays(15);
      const extended = await clocked.app.inject({ method: "GET", url: `/d/${draftId}` });
      expect(extended.statusCode).toBe(200);
      expect(extended.body).toContain("Still visited");

      // Thirty-one days without a visit, and it is gone.
      clocked.advanceDays(31);
      const abandoned = await clocked.app.inject({ method: "GET", url: `/d/${draftId}` });
      expect(abandoned.statusCode).toBe(404);
    } finally {
      await clocked.close();
    }
  });

  it("serves a draft whose visit top-up write fails, without moving its clock", async () => {
    const clocked = await createClockedApp(
      "visit-write-failure",
      (file, clock) => new VisitFailingJsonDb(file, { clock })
    );

    try {
      const draftId = await publishDraft(clocked.app, "Survives a failed top-up");

      // Ten days left, so this visit is one the clock would move — and the
      // write throws. The reader still gets the page.
      clocked.advanceDays(80);
      const served = await clocked.app.inject({ method: "GET", url: `/d/${draftId}` });
      expect(served.statusCode).toBe(200);
      expect(served.body).toContain("Survives a failed top-up");

      // Best-effort means exactly that: the page was served and the clock
      // genuinely did not move, so the original window still ends it.
      clocked.advanceDays(11);
      const expired = await clocked.app.inject({ method: "GET", url: `/d/${draftId}` });
      expect(expired.statusCode).toBe(404);
    } finally {
      await clocked.close();
    }
  });

  it("restarts the whole window when a new version is published", async () => {
    const clocked = await createClockedApp("upload-reset");

    try {
      const draftId = await publishDraft(clocked.app, "First cut");

      clocked.advanceDays(80);
      const republish = await clocked.app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { authorization: "Bearer dev-token" },
        payload: {
          draftId,
          html: "<!doctype html><html><head><title>Second cut</title></head><body></body></html>"
        }
      });
      expect(republish.statusCode).toBe(200);

      // Day 100: past the first window, well inside the one the update opened.
      clocked.advanceDays(20);
      const served = await clocked.app.inject({ method: "GET", url: `/d/${draftId}` });
      expect(served.statusCode).toBe(200);
      expect(served.body).toContain("Second cut");
    } finally {
      await clocked.close();
    }
  });
});

interface ServedDraft {
  app: ReturnType<typeof createApp>;
  draftId: string;
  latestUrl: string;
  versionUrl: string;
  close: () => Promise<void>;
}

async function createServedDraft(label: string): Promise<ServedDraft> {
  const safeLabel = label.replaceAll(/[^a-z0-9]/gi, "-");
  const config = testConfig();
  const db = new JsonFilePatchPageDb(path.join(tempDir, `${safeLabel}-db.json`));
  await db.initialize("dev-token");
  const storage = new FileSystemHtmlStorage(path.join(tempDir, `${safeLabel}-drafts`));
  const app = createApp({ config, db, storage });

  const upload = await app.inject({
    method: "POST",
    url: "/api/uploads",
    headers: { authorization: "Bearer dev-token" },
    payload: {
      html: "<!doctype html><html><head><title>Serving Guarantees</title></head><body><p>Served.</p></body></html>"
    }
  });
  expect(upload.statusCode).toBe(201);
  const body = upload.json() as { draftId: string; versionNumber: number };

  return {
    app,
    draftId: body.draftId,
    latestUrl: `/d/${body.draftId}`,
    versionUrl: `/d/${body.draftId}/v/${body.versionNumber}`,
    close: async () => {
      await app.close();
      await db.close();
    }
  };
}

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

async function markJsonTokenRevoked(filePath: string, name: string): Promise<void> {
  const state = JSON.parse(await readFile(filePath, "utf8")) as {
    apiTokens: Array<{ name: string; revokedAt: string | null }>;
  };
  const token = state.apiTokens.find((row) => row.name === name);
  expect(token).toBeDefined();
  token!.revokedAt = "2026-01-01T00:00:00.000Z";
  await writeFile(filePath, JSON.stringify(state, null, 2));
}

async function createScopedTokenApp(label: string, clock?: () => number): Promise<ScopedTokenApp> {
  const safeLabel = label.replaceAll(/[^a-z0-9]/gi, "-");
  const config = testConfig();
  const db = new JsonFilePatchPageDb(path.join(tempDir, `${safeLabel}-db.json`));
  await db.initialize("admin-token");
  const adminAuth = await db.findApiTokenByToken("admin-token");
  expect(adminAuth).not.toBeNull();
  await db.createApiToken({
    accountId: adminAuth!.accountId,
    name: "Read token",
    token: "read-token",
    scopes: ["read"]
  });
  await db.createApiToken({
    accountId: adminAuth!.accountId,
    name: "Upload token",
    token: "upload-token",
    scopes: ["upload"]
  });
  await db.createApiToken({
    accountId: adminAuth!.accountId,
    name: "Admin only token",
    token: "admin-only-token",
    scopes: ["admin"]
  });
  const storage = new FileSystemHtmlStorage(path.join(tempDir, `${safeLabel}-drafts`));
  const app = createApp({ config, db, storage, clock });
  return { app, db };
}

function draftHtml(title: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`;
}

async function createDraft(
  app: ReturnType<typeof createApp>,
  token: string,
  title: string
) {
  return app.inject({
    method: "POST",
    url: "/api/uploads",
    headers: { authorization: `Bearer ${token}` },
    payload: { html: draftHtml(title) }
  });
}

async function updateDraft(
  app: ReturnType<typeof createApp>,
  token: string,
  draftId: string,
  title: string
) {
  return app.inject({
    method: "POST",
    url: "/api/uploads",
    headers: { authorization: `Bearer ${token}` },
    payload: { draftId, html: draftHtml(title) }
  });
}

async function oversizedJsonApiRequest(
  app: ReturnType<typeof createApp>,
  options: { target: ApiTargetCase; token: string }
) {
  const authorization = `Bearer ${options.token}`;
  if (options.target.rawHttp) {
    return rawHttpRequest(
      app,
      options.target.url,
      "{\"html\":\"",
      {
        Authorization: authorization,
        "Content-Type": "application/json",
        "Content-Length": String(2 * 1024 * 1024 + 1)
      },
      { closeAfterWrite: false }
    );
  }

  return app.inject({
    method: options.target.method || "POST",
    url: options.target.url,
    headers: {
      authorization,
      "content-type": "application/json"
    },
    payload: `{"html":"${"x".repeat(2 * 1024 * 1024)}`
  });
}

async function rawHttpRequest(
  app: ReturnType<typeof createApp>,
  requestTarget: string,
  payload = "",
  headers: Record<string, string> = {},
  options: { closeAfterWrite?: boolean; method?: string } = {}
): Promise<RawHttpResponse> {
  const address = app.server.address();
  const port =
    address && typeof address !== "string"
      ? address.port
      : await listenOnLoopback(app);

  const raw = await new Promise<string>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    let response = "";
    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      resolve(response);
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(2_000, () => {
      socket.destroy();
      rejectOnce(new Error("Timed out waiting for raw HTTP response."));
    });
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("end", resolveOnce);
    socket.on("error", (error) => {
      if (response) {
        resolveOnce();
        return;
      }
      rejectOnce(error);
    });
    socket.on("connect", () => {
      const requestHeaders = {
        Host: "host",
        Connection: "close",
        "Content-Length": String(Buffer.byteLength(payload)),
        ...headers
      };
      const headerLines = Object.entries(requestHeaders).map(
        ([name, value]) => `${name}: ${value}`
      );
      const request = [
        `${options.method ?? "POST"} ${requestTarget} HTTP/1.1`,
        ...headerLines,
        "",
        payload
      ].join("\r\n");
      if (options.closeAfterWrite === false) {
        socket.write(request);
        return;
      }
      socket.end(request);
    });
  });

  return parseRawHttpResponse(raw);
}

async function listenOnLoopback(app: ReturnType<typeof createApp>): Promise<number> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected Fastify test server to listen on a TCP address.");
  }
  return (address as AddressInfo).port;
}

function parseRawHttpResponse(raw: string): RawHttpResponse {
  const [head = "", encodedBody = ""] = raw.split("\r\n\r\n", 2);
  const [statusLine = "", ...headerLines] = head.split("\r\n");
  const statusCode = Number(statusLine.split(" ")[1]);
  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const index = line.indexOf(":");
    if (index === -1) continue;
    headers[line.slice(0, index).toLowerCase()] = line.slice(index + 1).trim();
  }
  const body =
    headers["transfer-encoding"]?.toLowerCase() === "chunked"
      ? decodeChunkedBody(encodedBody)
      : encodedBody;

  return {
    statusCode,
    headers,
    json: () => JSON.parse(body)
  };
}

function decodeChunkedBody(encodedBody: string): string {
  let cursor = 0;
  let decoded = "";
  while (cursor < encodedBody.length) {
    const lineEnd = encodedBody.indexOf("\r\n", cursor);
    if (lineEnd === -1) break;
    const size = Number.parseInt(encodedBody.slice(cursor, lineEnd), 16);
    if (!size) break;
    const chunkStart = lineEnd + 2;
    decoded += encodedBody.slice(chunkStart, chunkStart + size);
    cursor = chunkStart + size + 2;
  }
  return decoded;
}

type RawHttpResponse = {
  statusCode: number;
  headers: Record<string, string>;
  json: () => unknown;
};

type ApiTargetCase = {
  label: string;
  url: string;
  method?: string;
  rawHttp?: boolean;
};

type ScopedTokenApp = {
  app: ReturnType<typeof createApp>;
  db: JsonFilePatchPageDb;
};

type ClockedApp = {
  app: ReturnType<typeof createApp>;
  advanceDays(days: number): void;
  close(): Promise<void>;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * An app whose clock can be wound forward months. The database gets the *same*
 * clock: the retention clock is the database's, so an app-only clock would move
 * the rate limiters and nothing else.
 */
async function createClockedApp(
  label: string,
  openDb: (file: string, clock: () => number) => JsonFilePatchPageDb = (file, clock) =>
    new JsonFilePatchPageDb(file, { clock })
): Promise<ClockedApp> {
  let now = Date.UTC(2026, 0, 1);
  const clock = (): number => now;
  const db = openDb(path.join(tempDir, `${label}-db.json`), clock);
  await db.initialize("dev-token");
  const storage = new FileSystemHtmlStorage(path.join(tempDir, `${label}-drafts`));
  const app = createApp({ config: testConfig(), db, storage, clock });

  return {
    app,
    advanceDays(days) {
      now += days * DAY_MS;
    },
    async close() {
      await app.close();
      await db.close();
    }
  };
}

async function publishDraft(
  app: ReturnType<typeof createApp>,
  title: string
): Promise<string> {
  const upload = await app.inject({
    method: "POST",
    url: "/api/uploads",
    headers: { authorization: "Bearer dev-token" },
    payload: {
      html: `<!doctype html><html><head><title>${title}</title></head><body></body></html>`
    }
  });
  expect(upload.statusCode).toBe(201);
  return (upload.json() as { draftId: string }).draftId;
}

/** A store that can serve a draft but cannot record the visit that follows. */
class VisitFailingJsonDb extends JsonFilePatchPageDb {
  override async recordDraftVisit(): Promise<void> {
    throw new Error("Forced visit top-up failure.");
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
    protectedApiRateLimitPerMinute: 60,
    authenticatedUploadRateLimitPerMinute: 20,
    anonymousCreateRateLimitPerMinute: 5,
    draftCreateRateLimitPerMinute: 10,
    liveDraftsPerToken: 1_000,
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
