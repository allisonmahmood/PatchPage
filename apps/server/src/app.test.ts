import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACCEPTABLE_USE_URL, getServerConfig } from "@patchpage/config";
import type { ServerConfig } from "@patchpage/config";
import { sha256 } from "@patchpage/core";
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

  it("refuses a tokenless upload under every configuration", async () => {
    for (const allowSelfServiceTokens of [false, true]) {
      const label = `allowSelfServiceTokens=${allowSelfServiceTokens}`;
      const config = { ...testConfig(), allowSelfServiceTokens };
      const db = new JsonFilePatchPageDb(
        path.join(tempDir, `tokenless-db-${allowSelfServiceTokens}.json`)
      );
      await db.initialize(null);
      const storage = new FileSystemHtmlStorage(
        path.join(tempDir, `tokenless-drafts-${allowSelfServiceTokens}`)
      );
      const app = createApp({ config, db, storage });
      const html =
        "<!doctype html><html><head><title>Tokenless</title></head><body>marker</body></html>";

      try {
        for (const payload of [
          { html },
          { html, draftId: null },
          { html, draftId: "abcdefghijkl" }
        ]) {
          const upload = await app.inject({
            method: "POST",
            url: "/api/uploads",
            payload
          });

          expect(upload.statusCode, label).toBe(401);
          expect(upload.json(), label).toEqual({
            ok: false,
            error: "Missing or invalid API token."
          });
        }
      } finally {
        await app.close();
        await db.close();
      }
    }
  });

  it("does not admit an absent credential on a non-create upload method", async () => {
    const config = { ...testConfig(), allowSelfServiceTokens: true };
    const db = new JsonFilePatchPageDb(path.join(tempDir, "tokenless-method-db.json"));
    await db.initialize(null);
    const storage = new FileSystemHtmlStorage(
      path.join(tempDir, "tokenless-method-drafts")
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

  it("keeps every upload-like POST target authenticated", async () => {
    const config = { ...testConfig(), allowSelfServiceTokens: true };
    const db = new JsonFilePatchPageDb(path.join(tempDir, "upload-route-db.json"));
    await db.initialize(null);
    const storage = new FileSystemHtmlStorage(path.join(tempDir, "upload-route-drafts"));
    const app = createApp({ config, db, storage });

    try {
      for (const target of [...uploadLikeApiTargets, { label: "exact upload route", url: "/api/uploads" }]) {
        const response = target.rawHttp
          ? await rawHttpRequest(app, target.url)
          : await app.inject({
              method: ("method" in target && target.method) || "POST",
              url: target.url,
              payload: {}
            });
        expect(response.statusCode, target.label).toBe(401);
        expect(response.json(), target.label).toEqual({
          ok: false,
          error: "Missing or invalid API token."
        });
      }
    } finally {
      await app.close();
      await db.close();
    }
  });

  it("lets admin credentials alone moderate another principal's draft", async () => {
    const config = testConfig();
    const db = new JsonFilePatchPageDb(path.join(tempDir, "moderation-db.json"));
    await db.initialize("admin-token");
    const admin = await db.findApiTokenByToken("admin-token");
    if (!admin) throw new Error("Expected bootstrap authentication.");
    await db.createApiToken({
      accountId: admin.accountId,
      name: "Ordinary token",
      token: "ordinary-token",
      scopes: ["upload"]
    });
    const storage = new FileSystemHtmlStorage(path.join(tempDir, "moderation-drafts"));
    const app = createApp({ config, db, storage });
    let foreignDraftSequence = 0;
    const createForeignDraft = async (): Promise<string> => {
      foreignDraftSequence += 1;
      const draftId = `zzzzzzzzzzz${foreignDraftSequence}`;
      await db.recordUpload({
        intent: "create",
        draftId,
        versionId: `ver_foreign_${foreignDraftSequence}`,
        accountId: "acct_foreign",
        apiTokenId: admin.id,
        title: "Another principal's draft",
        objectKey: `drafts/${draftId}/versions/ver_foreign_${foreignDraftSequence}.html`,
        contentHash: `sha256:foreign${foreignDraftSequence}`,
        fileSize: 1,
        filename: "foreign.html",
        metadata: {},
        sourceIp: null,
        userAgent: "vitest"
      });
      return draftId;
    };

    try {
      const disableDraftId = await createForeignDraft();
      for (const request of [
        { method: "GET" as const, url: "/api/me" },
        {
          method: "POST" as const,
          url: `/api/drafts/${disableDraftId}/disable`,
          payload: { reason: "tokenless attempt" }
        },
        { method: "DELETE" as const, url: `/api/drafts/${disableDraftId}` }
      ]) {
        const tokenlessOperation = await app.inject(request);
        expect(tokenlessOperation.statusCode).toBe(401);
      }

      // An ordinary upload token reaches only what it owns.
      const ordinaryDisable = await app.inject({
        method: "POST",
        url: `/api/drafts/${disableDraftId}/disable`,
        headers: { authorization: "Bearer ordinary-token" },
        payload: { reason: "not a moderator" }
      });
      expect(ordinaryDisable.statusCode).toBe(404);

      // The operator's takedown path: admin scope reaches any principal's draft,
      // which is what completes the moderation loop.
      const adminDisable = await app.inject({
        method: "POST",
        url: `/api/drafts/${disableDraftId}/disable`,
        headers: { authorization: "Bearer admin-token" },
        payload: { reason: "operator policy" }
      });
      expect(adminDisable.statusCode).toBe(200);

      const deleteDraftId = await createForeignDraft();
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
    } finally {
      await app.close();
      await db.close();
    }
  });

  it("does not downgrade present bad credentials when self-service tokens are allowed", async () => {
    const config = { ...testConfig(), allowSelfServiceTokens: true };
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

      // A bad credential never opens a tokenless door, even with the flag on.
      const tokenlessAfterBadCredentials = await app.inject({
        method: "POST",
        url: "/api/uploads",
        payload: {
          html: "<!doctype html><html><head><title>Still closed</title></head><body></body></html>"
        }
      });
      expect(tokenlessAfterBadCredentials.statusCode).toBe(401);

      // A good credential is unaffected by the rejected attempts before it.
      const goodAfterBadCredentials = await app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { authorization: "Bearer admin-token" },
        payload: {
          html: "<!doctype html><html><head><title>Good credential</title></head><body></body></html>"
        }
      });
      expect(goodAfterBadCredentials.statusCode).toBe(201);
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

  it("pins a draft only for an admin token, and only one that is there", async () => {
    const { app, db } = await createScopedTokenApp("pin-admin-only");

    try {
      const created = await createDraft(app, "upload-token", "Pinnable");
      expect(created.statusCode).toBe(201);
      const { draftId } = created.json() as { draftId: string };

      // Pinning is the operator's act, so the token that made the draft cannot
      // exempt it from expiry — only an admin can.
      for (const suffix of ["pin", "unpin"]) {
        const refused = await app.inject({
          method: "POST",
          url: `/api/drafts/${draftId}/${suffix}`,
          headers: { authorization: "Bearer upload-token" }
        });
        expect(refused.statusCode).toBe(403);
        expect(refused.json()).toEqual({
          ok: false,
          error: "API token does not have the required scope."
        });
      }

      // An admin pins any draft, whoever holds it.
      const pinned = await app.inject({
        method: "POST",
        url: `/api/drafts/${draftId}/pin`,
        headers: { authorization: "Bearer admin-only-token" }
      });
      expect(pinned.statusCode).toBe(200);
      expect(pinned.json()).toEqual({ ok: true, pinned: true });

      const missing = await app.inject({
        method: "POST",
        url: "/api/drafts/doesnotexist1/pin",
        headers: { authorization: "Bearer admin-only-token" }
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ ok: false, error: "Draft not found." });
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
    },
    {
      label: "pin overlong route parameter",
      protectedTarget: `/api/drafts/${"x".repeat(101)}/pin`,
      authenticatedStatus: 414,
      authenticatedError: "Request target is too long."
    },
    {
      label: "unpin overlong route parameter",
      protectedTarget: `/api/drafts/${"x".repeat(101)}/unpin`,
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

  it("composes protected-API and token upload limits independently", async () => {
    let now = 1_000;
    const config = {
      ...testConfig(),
      allowSelfServiceTokens: true,
      protectedApiRateLimitPerMinute: 2,
      authenticatedUploadRateLimitPerMinute: 1
    };
    const db = new JsonFilePatchPageDb(path.join(tempDir, "upload-limit-db.json"));
    await db.initialize("upload-token");
    const storage = new FileSystemHtmlStorage(path.join(tempDir, "upload-limit-drafts"));
    const app = createApp({ config, db, storage, clock: () => now });

    try {
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
      expect(tokenLimited.headers["retry-after"]).toBe("60");

      const protectedLimited = await app.inject({
        method: "GET",
        url: "/api/me",
        headers: { authorization: "Bearer upload-token" }
      });
      expect(protectedLimited.statusCode).toBe(429);

      now = 61_000;
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

  it("footers every served draft with the report link and the acceptable use policy", async () => {
    const served = await createServedDraft("report-footer");

    for (const url of [served.latestUrl, served.versionUrl]) {
      const response = await served.app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);

      // The reader's channel to the operator, on both URL shapes. The footer
      // carries these two links and no others.
      expect(response.body).toContain(`href="/report/${served.draftId}"`);
      expect(response.body).toContain("Report this page");
      expect(response.body).toContain(`href="${ACCEPTABLE_USE_URL}"`);
      expect(response.headers["referrer-policy"]).toBe("no-referrer");

      // The footer is links, not script, because the draft policy forbids
      // script and forbids a form submitting from here.
      expect(response.body).not.toContain("<script");
      expect(response.body).not.toContain("<form");
      expect(response.body).not.toContain("onclick");

      // And carrying it changed nothing about how a draft is served.
      expect(response.headers["content-security-policy"]).toBe(
        "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; " +
          "frame-src 'self' about:; base-uri 'none'; form-action 'none'"
      );
      expect(response.headers["set-cookie"]).toBeUndefined();
    }

    await served.close();
  });

  it("takes a report over plain navigation and acknowledges the reader immediately", async () => {
    const served = await createServedDraft("report-submit");
    const reportUrl = `/report/${served.draftId}`;

    // Step one is a link the footer already carries: an ordinary GET, whose
    // own response — not the draft's — is what may carry a form.
    const form = await served.app.inject({ method: "GET", url: reportUrl });
    expect(form.statusCode).toBe(200);
    expect(form.headers["content-type"]).toContain("text/html");
    expect(form.body).toContain(`<form class="panel panel-form" method="post" action="${reportUrl}"`);
    expect(form.body).toContain('name="reason"');
    expect(form.body).not.toContain("<script");
    expect(form.headers["content-security-policy"]).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; " +
        "base-uri 'none'; form-action 'self'"
    );
    expect(form.headers["content-security-policy"]).not.toContain("script");
    expect(form.headers["cache-control"]).toBe("no-store");
    expect(form.headers["x-robots-tag"]).toBe("noindex");
    expect(form.headers["referrer-policy"]).toBe("no-referrer");
    expect(form.headers["set-cookie"]).toBeUndefined();

    // Step two is that form submitting itself. No JavaScript ran to get here.
    const filed = await served.app.inject({
      method: "POST",
      url: reportUrl,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "reason=Impersonates+my+company"
    });
    expect(filed.statusCode).toBe(200);
    expect(filed.headers["content-type"]).toContain("text/html");
    expect(filed.body).toContain("Report received");
    expect(filed.headers["cache-control"]).toBe("no-store");
    expect(filed.headers["x-robots-tag"]).toBe("noindex");
    expect(filed.headers["referrer-policy"]).toBe("no-referrer");
    expect(filed.headers["set-cookie"]).toBeUndefined();

    // A reader with nothing to add is acknowledged the same way. What the two
    // submissions *stored* is the DB contract suite's to prove, not this seam's.
    const bare = await served.app.inject({
      method: "POST",
      url: reportUrl,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: ""
    });
    expect(bare.statusCode).toBe(200);
    expect(bare.body).toContain("Report received");

    await served.close();
  });

  it("keeps the report form parser out of the API", async () => {
    const served = await createServedDraft("report-parser-scope");

    // The urlencoded parser is registered in the report routes' own plugin
    // scope. If it ever leaked to the root instance, these would parse instead
    // of being refused, and a form post would become a valid API call.
    for (const url of ["/api/uploads", "/api/tokens"]) {
      const response = await served.app.inject({
        method: "POST",
        url,
        headers: {
          authorization: "Bearer dev-token",
          "content-type": "application/x-www-form-urlencoded"
        },
        payload: "html=%3Cp%3Ehi%3C%2Fp%3E&name=leaked"
      });
      expect(response.statusCode).toBe(415);
    }

    // And the API's ordinary answers are untouched either way.
    const me = await served.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: "Bearer dev-token" }
    });
    expect(me.statusCode).toBe(200);

    await served.close();
  });

  it("never lets reports take a draft down, however many arrive", async () => {
    const served = await createServedDraft("report-bomb");

    const before = await served.app.inject({ method: "GET", url: served.latestUrl });
    expect(before.statusCode).toBe(200);

    for (let index = 0; index < 40; index += 1) {
      const filed = await served.app.inject({
        method: "POST",
        url: `/report/${served.draftId}`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: `reason=Bomb+${index}`
      });
      // Every reader is acknowledged; none of them is a takedown.
      expect(filed.statusCode).toBe(200);
    }

    for (const url of [served.latestUrl, served.versionUrl]) {
      const after = await served.app.inject({ method: "GET", url });
      expect(after.statusCode).toBe(200);
      expect(after.body).toContain("Served.");
    }

    // Taking it down stays where it always was: an operator's decision.
    const disabled = await served.app.inject({
      method: "POST",
      url: `/api/drafts/${served.draftId}/disable`,
      headers: { authorization: "Bearer dev-token" },
      payload: { reason: "Operator reviewed the reports." }
    });
    expect(disabled.statusCode).toBe(200);
    expect(
      (await served.app.inject({ method: "GET", url: served.latestUrl })).statusCode
    ).toBe(404);

    await served.close();
  });

  it("opens a report path only for a draft a reader could have read", async () => {
    const served = await createServedDraft("report-unreadable");

    const disable = await served.app.inject({
      method: "POST",
      url: `/api/drafts/${served.draftId}/disable`,
      headers: { authorization: "Bearer dev-token" },
      payload: { reason: "Operator decision." }
    });
    expect(disable.statusCode).toBe(200);

    // A disabled draft, an unknown ID, and a malformed one are all the same
    // 404 the draft URL itself gives — an unreadable page is unreportable, and
    // a made-up ID is never a way to write a row.
    for (const draftId of [served.draftId, "doesnotexist1", "not a draft id"]) {
      for (const method of ["GET", "POST"] as const) {
        const response = await served.app.inject({
          method,
          url: `/report/${encodeURIComponent(draftId)}`,
          headers:
            method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {},
          payload: method === "POST" ? "reason=Nothing+here" : undefined
        });
        expect(response.statusCode).toBe(404);
        expect(response.headers["content-type"]).toContain("text/html");
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.headers["set-cookie"]).toBeUndefined();
      }
    }

    await served.close();
  });

  /**
   * The one report test here that reads the store, because these two facts do
   * not exist anywhere else. What a report *is* once stored — its reason, its
   * trimming, its scoping to one draft — is the DB contract suite's, proved on
   * both drivers. What only this seam can answer is whether the app hands the
   * store the right things: the reader's resolved address, and nothing at all
   * for a draft nobody could have read. Same shape as the upload path's
   * source-IP attribution test.
   */
  it("attributes a filed report to the reader's address, and writes nothing for an unreadable draft", async () => {
    const served = await createServedDraft("report-attribution");

    const filed = await served.app.inject({
      method: "POST",
      url: `/report/${served.draftId}`,
      remoteAddress: "198.51.100.23",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "reason=From+a+specific+address"
    });
    expect(filed.statusCode).toBe(200);

    const stored = await served.db.listDraftReports(served.draftId);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.sourceIp).toBe("198.51.100.23");

    // A made-up ID is never a way to write a row: the handler resolves the
    // draft before it stores anything.
    const missing = await served.app.inject({
      method: "POST",
      url: "/report/doesnotexist1",
      remoteAddress: "198.51.100.24",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "reason=Nothing+here"
    });
    expect(missing.statusCode).toBe(404);
    expect(await served.db.listDraftReports("doesnotexist1")).toEqual([]);

    await served.close();
  });

  it("treats reporting a page as something other than reading it", async () => {
    const clocked = await createClockedApp("report-not-a-visit");

    try {
      const draftId = await publishDraft(clocked.app, "Quietly reported");

      // Deep into the top-up window, where a real visit would move the clock.
      clocked.advanceDays(75);
      for (let index = 0; index < 5; index += 1) {
        expect(
          (await clocked.app.inject({ method: "GET", url: `/report/${draftId}` })).statusCode
        ).toBe(200);
        expect(
          (
            await clocked.app.inject({
              method: "POST",
              url: `/report/${draftId}`,
              headers: { "content-type": "application/x-www-form-urlencoded" },
              payload: "reason=Still+here"
            })
          ).statusCode
        ).toBe(200);
      }

      // Reporting a page is not reading it, so none of that bought the draft a
      // single day: the original 90-day clock still runs out on time.
      clocked.advanceDays(16);
      expect(
        (await clocked.app.inject({ method: "GET", url: `/d/${draftId}` })).statusCode
      ).toBe(404);
    } finally {
      await clocked.close();
    }
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
    const clocked = await createClockedApp("visit-write-failure", {
      openDb: (file, clock) => new VisitFailingJsonDb(file, { clock })
    });

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

  it("takes an expired draft's content and record together, with no way back", async () => {
    const clocked = await createClockedApp("expiry-sweep");

    try {
      const draftId = await publishDraft(clocked.app, "Ages out");
      const updated = await clocked.app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { authorization: "Bearer dev-token" },
        payload: { draftId, html: draftHtml("Ages out, twice") }
      });
      expect(updated.statusCode).toBe(200);
      expect(await listFiles(clocked.storageDir)).toHaveLength(2);

      // Expired, and so already unserved — but every stored byte is still here,
      // which is what the sweep exists to change.
      clocked.advanceDays(91);
      expect(await listFiles(clocked.storageDir)).toHaveLength(2);

      expect(await clocked.app.sweepExpiredDrafts()).toEqual({
        deleted: 1,
        skipped: 0,
        failed: 0,
        orphanedObjects: 0
      });

      expect(await listFiles(clocked.storageDir)).toEqual([]);
      for (const url of [`/d/${draftId}`, `/d/${draftId}/v/1`, `/d/${draftId}/v/2`]) {
        const gone = await clocked.app.inject({ method: "GET", url });
        expect(gone.statusCode).toBe(404);
        expect(gone.body).not.toContain("Ages out");
      }

      // Republishing is the recovery path, and it is a new page.
      const republished = await clocked.app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { authorization: "Bearer dev-token" },
        payload: { draftId, html: draftHtml("Too late") }
      });
      expect(republished.statusCode).toBe(404);
    } finally {
      await clocked.close();
    }
  });

  it("keeps a pinned draft serving forever, and lets it go once it is unpinned", async () => {
    const clocked = await createClockedApp("expiry-sweep-pinned");

    try {
      const draftId = await publishDraft(clocked.app, "Welcome page");
      const pinned = await clocked.app.inject({
        method: "POST",
        url: `/api/drafts/${draftId}/pin`,
        headers: { authorization: "Bearer dev-token" }
      });
      expect(pinned.statusCode).toBe(200);
      expect(pinned.json()).toEqual({ ok: true, pinned: true });

      // A year with nobody reading it, and the instance's own page is still up.
      clocked.advanceDays(365);
      const served = await clocked.app.inject({ method: "GET", url: `/d/${draftId}` });
      expect(served.statusCode).toBe(200);
      expect(served.body).toContain("Welcome page");

      expect(await clocked.app.sweepExpiredDrafts()).toMatchObject({ deleted: 0 });
      const survived = await clocked.app.inject({ method: "GET", url: `/d/${draftId}` });
      expect(survived.statusCode).toBe(200);
      expect(await listFiles(clocked.storageDir)).toHaveLength(1);

      const unpinned = await clocked.app.inject({
        method: "POST",
        url: `/api/drafts/${draftId}/unpin`,
        headers: { authorization: "Bearer dev-token" }
      });
      expect(unpinned.statusCode).toBe(200);
      expect(unpinned.json()).toEqual({ ok: true, pinned: false });

      // The visit above topped the clock up to thirty days, so the page keeps
      // its window — and then goes, content and all.
      clocked.advanceDays(31);
      expect(await clocked.app.sweepExpiredDrafts()).toMatchObject({ deleted: 1 });
      const gone = await clocked.app.inject({ method: "GET", url: `/d/${draftId}` });
      expect(gone.statusCode).toBe(404);
      expect(await listFiles(clocked.storageDir)).toEqual([]);
    } finally {
      await clocked.close();
    }
  });

  it("frees a pinned draft the operator deleted, pin and all", async () => {
    const clocked = await createClockedApp("expiry-sweep-pinned-then-deleted");

    try {
      const draftId = await publishDraft(clocked.app, "Pinned then withdrawn");
      const pinned = await clocked.app.inject({
        method: "POST",
        url: `/api/drafts/${draftId}/pin`,
        headers: { authorization: "Bearer dev-token" }
      });
      expect(pinned.statusCode).toBe(200);

      const deleted = await clocked.app.inject({
        method: "DELETE",
        url: `/api/drafts/${draftId}`,
        headers: { authorization: "Bearer dev-token" }
      });
      expect(deleted.statusCode).toBe(200);

      // Taking the page down ended the pin, so the ordinary clock applies and
      // the sweep frees the storage. A pin that survived here would exempt
      // bytes nobody can reach, with no way to unpin them back into reach.
      clocked.advanceDays(91);
      expect(await clocked.app.sweepExpiredDrafts()).toMatchObject({ deleted: 1 });
      expect(await listFiles(clocked.storageDir)).toEqual([]);

      // And pinning it again was never on the table.
      const repinned = await clocked.app.inject({
        method: "POST",
        url: `/api/drafts/${draftId}/pin`,
        headers: { authorization: "Bearer dev-token" }
      });
      expect(repinned.statusCode).toBe(404);
    } finally {
      await clocked.close();
    }
  });

  it("sweeps repeatedly and concurrently while the server keeps serving", async () => {
    const clocked = await createClockedApp("expiry-sweep-idempotent");

    try {
      const expiring = await publishDraft(clocked.app, "Abandoned");
      clocked.advanceDays(91);
      const fresh = await publishDraft(clocked.app, "Still here");

      // Two runs at once are one run: the second finds nothing half-swept.
      const [first, second] = await Promise.all([
        clocked.app.sweepExpiredDrafts(),
        clocked.app.sweepExpiredDrafts()
      ]);
      expect(first).toEqual({ deleted: 1, skipped: 0, failed: 0, orphanedObjects: 0 });
      expect(second).toEqual(first);

      // Running again changes nothing, and the live draft was never in reach.
      expect(await clocked.app.sweepExpiredDrafts()).toEqual({
        deleted: 0,
        skipped: 0,
        failed: 0,
        orphanedObjects: 0
      });

      const gone = await clocked.app.inject({ method: "GET", url: `/d/${expiring}` });
      expect(gone.statusCode).toBe(404);
      const served = await clocked.app.inject({ method: "GET", url: `/d/${fresh}` });
      expect(served.statusCode).toBe(200);
      expect(served.body).toContain("Still here");
      expect(await listFiles(clocked.storageDir)).toHaveLength(1);
    } finally {
      await clocked.close();
    }
  });

  it("counts an object it could not delete once the record is already gone", async () => {
    const clocked = await createClockedApp("expiry-sweep-storage-failure", {
      openStorage: (dir) => new ControlledHtmlStorage(dir)
    });
    const storage = clocked.storage as ControlledHtmlStorage;

    try {
      const draftId = await publishDraft(clocked.app, "Object outlives its record");
      clocked.advanceDays(91);
      storage.deleteError = new Error("Storage delete failed.");

      expect(await clocked.app.sweepExpiredDrafts()).toEqual({
        deleted: 1,
        skipped: 0,
        failed: 0,
        orphanedObjects: 1
      });

      // The record went and the object stayed. Nothing serves it and no later
      // run can find it — storage to reclaim by hand, not a draft that survived.
      expect(await listFiles(clocked.storageDir)).toHaveLength(1);
      const gone = await clocked.app.inject({ method: "GET", url: `/d/${draftId}` });
      expect(gone.statusCode).toBe(404);
      expect(await clocked.app.sweepExpiredDrafts()).toMatchObject({
        deleted: 0,
        orphanedObjects: 0
      });
    } finally {
      await clocked.close();
    }
  });
});

describe("self-service minting", () => {
  it("mints a token whose plaintext appears once and is kept only as a hash", async () => {
    const minting = await createMintApp("mint-happy");

    try {
      const mint = await minting.mint("198.51.100.20");

      expect(mint.statusCode).toBe(201);
      const body = mint.json() as { ok: boolean; token: string; aupUrl: string };
      expect(body.ok).toBe(true);
      expect(body.token).toMatch(/^pp_[A-Za-z0-9_-]{43}$/);
      expect(body.aupUrl).toBe(ACCEPTABLE_USE_URL);
      // The pinned success body is exactly these three keys — nothing about the
      // principal, the mint record, or the quota leaks into it.
      expect(Object.keys(body).sort()).toEqual(["aupUrl", "ok", "token"]);
      // No credential was offered and none was asked for: this is how a caller
      // with nothing gets its first token.
      expect(mint.headers["cache-control"]).toBe("no-store");

      // The token works, and the mint date is what named it.
      const me = await minting.app.inject({
        method: "GET",
        url: "/api/me",
        headers: { authorization: `Bearer ${body.token}` }
      });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({
        apiTokenName: "Self-service token 2026-01-01",
        scopes: ["upload"]
      });

      // "Exactly once" is a claim about storage as much as about the wire, and
      // the wire alone cannot make it. This is the one assertion in the suite
      // that reads what the instance kept: the plaintext is not in it.
      const stored = await readFile(minting.dbFile, "utf8");
      expect(stored).not.toContain(body.token);
      expect(stored).toContain(sha256(body.token));
    } finally {
      await minting.close();
    }
  });

  it("refuses to mint on an instance that keeps its admin-only token posture", async () => {
    const minting = await createMintApp("mint-disabled", { allowSelfServiceTokens: false });

    try {
      const refused = await minting.mint("198.51.100.21");

      expect(refused.statusCode).toBe(403);
      // Exactly the pinned refusal: no extra key, and `error` carries real copy
      // rather than being present and empty.
      expect(refusalBody(refused)).toEqual({
        ok: false,
        code: "self_service_disabled"
      });
      expect((refused.json() as { error: string }).error).toMatch(/operator/i);

      // The admin token endpoint is a different operation and is untouched by
      // the flag: still admin-scoped, still named the same, still takes a body.
      const unauthenticated = await minting.app.inject({
        method: "POST",
        url: "/api/tokens",
        payload: { name: "Sneaky" }
      });
      expect(unauthenticated.statusCode).toBe(401);

      const administered = await minting.app.inject({
        method: "POST",
        url: "/api/tokens",
        headers: { authorization: "Bearer dev-token" },
        payload: { name: "Operator issued" }
      });
      expect(administered.statusCode).toBe(201);
      expect(administered.json()).toMatchObject({
        ok: true,
        apiToken: { name: "Operator issued" }
      });
    } finally {
      await minting.close();
    }
  });

  it("accepts an absent body and an empty JSON object alike", async () => {
    const minting = await createMintApp("mint-bodies");

    try {
      const shapes: Array<{ label: string; headers?: Record<string, string>; payload?: string }> =
        [
          { label: "no body and no content type" },
          {
            label: "empty JSON object",
            headers: { "content-type": "application/json" },
            payload: "{}"
          },
          {
            label: "JSON content type with nothing in the body",
            headers: { "content-type": "application/json" },
            payload: ""
          }
        ];

      const minted = new Set<string>();
      for (const shape of shapes) {
        const mint = await minting.app.inject({
          method: "POST",
          url: MINT_PATH,
          remoteAddress: "198.51.100.22",
          ...(shape.headers ? { headers: shape.headers } : {}),
          ...(shape.payload === undefined ? {} : { payload: shape.payload })
        });

        expect(mint.statusCode, shape.label).toBe(201);
        minted.add((mint.json() as { token: string }).token);
      }

      // Three requests, three distinct tokens — no shape was a silent no-op.
      expect(minted.size).toBe(3);

      // A body that is neither absent nor JSON is still a bad request: the
      // route is lenient about emptiness, not about malformed input.
      const malformed = await minting.app.inject({
        method: "POST",
        url: MINT_PATH,
        headers: { "content-type": "application/json" },
        payload: "{oops",
        remoteAddress: "198.51.100.23"
      });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json()).toMatchObject({ ok: false, error: "Malformed JSON body." });

      // And the leniency belongs to this route alone. An empty upload body is
      // still refused by Fastify's own parser before the handler sees it —
      // which is also what proves the mint route's parser stayed encapsulated
      // rather than quietly loosening every route in the app.
      const emptyUpload = await minting.app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: {
          authorization: "Bearer dev-token",
          "content-type": "application/json"
        },
        payload: ""
      });
      expect(emptyUpload.statusCode).toBe(400);
      expect((emptyUpload.json() as { error: string }).error).toMatch(
        /Body cannot be empty/i
      );
    } finally {
      await minting.close();
    }
  });

  it("counts the daily mint quota in the database, where a restart cannot clear it", async () => {
    const minting = await createMintApp("mint-quota", { selfServiceMintsPerIpPerDay: 2 });

    try {
      expect((await minting.mint("203.0.113.30")).statusCode).toBe(201);
      expect((await minting.mint("203.0.113.30")).statusCode).toBe(201);

      const exceeded = await minting.mint("203.0.113.30");
      expect(exceeded.statusCode).toBe(429);
      // The pinned refusal plus `quota`, which is the one documented addition —
      // spelled out so a future change to the shape has to come through here.
      expect(refusalBody(exceeded)).toEqual({
        ok: false,
        code: "mint_quota_exceeded",
        quota: 2
      });
      // Copy speaks the rolling window rather than a calendar day.
      expect((exceeded.json() as { error: string }).error).toMatch(/24 hours/);

      // Another address carries its own tally.
      expect((await minting.mint("203.0.113.31")).statusCode).toBe(201);

      // A restart empties every bucket held in memory. The quota is not one of
      // them: it is recounted from the stored mint records.
      await minting.restart();
      const afterRestart = await minting.mint("203.0.113.30");
      expect(afterRestart.statusCode).toBe(429);
      expect(afterRestart.json()).toMatchObject({ code: "mint_quota_exceeded" });

      // The window rolls rather than resetting at a fixed hour, so the day has
      // to pass from the mints themselves before the address mints again.
      minting.advanceMs(DAY_MS + 1_000);
      expect((await minting.mint("203.0.113.30")).statusCode).toBe(201);
    } finally {
      await minting.close();
    }
  });

  it("throttles mints per minute from one address, in memory", async () => {
    const minting = await createMintApp("mint-rate", {
      selfServiceMintRateLimitPerMinute: 2,
      selfServiceMintsPerIpPerDay: 100
    });

    try {
      expect((await minting.mint("203.0.113.40")).statusCode).toBe(201);
      expect((await minting.mint("203.0.113.40")).statusCode).toBe(201);

      const limited = await minting.mint("203.0.113.40");
      expect(limited.statusCode).toBe(429);
      // Exactly the pinned refusal. `retryAfterSeconds` must be a positive
      // number, which is what the CLI relays as the wait.
      expect(refusalBody(limited)).toEqual({
        ok: false,
        code: "rate_limited",
        retryAfterSeconds: 60
      });
      expect(limited.headers["retry-after"]).toBe("60");

      // Another address is unaffected; the bucket is per source address.
      expect((await minting.mint("203.0.113.41")).statusCode).toBe(201);

      minting.advanceMs(60_000);
      expect((await minting.mint("203.0.113.40")).statusCode).toBe(201);

      // In memory and nowhere else: a restart hands the address a fresh minute
      // even though the day's tally in the database keeps counting.
      expect((await minting.mint("203.0.113.40")).statusCode).toBe(201);
      expect((await minting.mint("203.0.113.40")).statusCode).toBe(429);
      await minting.restart();
      expect((await minting.mint("203.0.113.40")).statusCode).toBe(201);
    } finally {
      await minting.close();
    }
  });

  it("gives every mint its own principal with own-drafts-only rights", async () => {
    const minting = await createMintApp("mint-rights");

    try {
      const first = await minting.mintedToken("203.0.113.50");
      const second = await minting.mintedToken("203.0.113.51");

      // Fresh principal per mint: the two tokens share nothing to own through.
      expect(first.accountId).not.toBe(second.accountId);

      const draftId = await minting.uploadAs(first.token, "First principal page");

      // The other minted token cannot reach a draft it does not own — not to
      // update it, not to moderate it, not to delete it.
      const foreignUpdate = await minting.app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { authorization: `Bearer ${second.token}` },
        payload: {
          draftId,
          html: "<!doctype html><html><head><title>Hijack</title></head><body></body></html>"
        }
      });
      expect(foreignUpdate.statusCode).toBe(404);

      const foreignDisable = await minting.app.inject({
        method: "POST",
        url: `/api/drafts/${draftId}/disable`,
        headers: { authorization: `Bearer ${second.token}` },
        payload: { reason: "not mine" }
      });
      expect(foreignDisable.statusCode).toBe(404);

      const foreignDelete = await minting.app.inject({
        method: "DELETE",
        url: `/api/drafts/${draftId}`,
        headers: { authorization: `Bearer ${second.token}` }
      });
      expect(foreignDelete.statusCode).toBe(404);

      // A draft the operator owns is just as far out of reach.
      const operatorDraftId = await publishDraft(minting.app, "Operator page");
      const reachUp = await minting.app.inject({
        method: "DELETE",
        url: `/api/drafts/${operatorDraftId}`,
        headers: { authorization: `Bearer ${first.token}` }
      });
      expect(reachUp.statusCode).toBe(404);

      // Never admin, so it cannot mint further tokens through the admin
      // endpoint however it asks.
      const escalation = await minting.app.inject({
        method: "POST",
        url: "/api/tokens",
        headers: { authorization: `Bearer ${first.token}` },
        payload: { name: "More reach", scopes: ["admin"] }
      });
      expect(escalation.statusCode).toBe(403);

      // Its own draft, though, it updates and deletes freely.
      const ownUpdate = await minting.app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { authorization: `Bearer ${first.token}` },
        payload: {
          draftId,
          html: "<!doctype html><html><head><title>Second cut</title></head><body></body></html>"
        }
      });
      expect(ownUpdate.statusCode).toBe(200);

      const ownDelete = await minting.app.inject({
        method: "DELETE",
        url: `/api/drafts/${draftId}`,
        headers: { authorization: `Bearer ${first.token}` }
      });
      expect(ownDelete.statusCode).toBe(200);
    } finally {
      await minting.close();
    }
  });

  it("subjects a minted principal's drafts to expiry like any other", async () => {
    const minting = await createMintApp("mint-expiry");

    try {
      const { token } = await minting.mintedToken("203.0.113.60");
      const draftId = await minting.uploadAs(token, "Minted and mortal");

      expect(
        (await minting.app.inject({ method: "GET", url: `/d/${draftId}` })).statusCode
      ).toBe(200);

      // Minting buys no exemption: the retention clock runs on this draft
      // exactly as it does on the operator's, and the sweep takes it.
      minting.advanceMs(91 * DAY_MS);
      expect(
        (await minting.app.inject({ method: "GET", url: `/d/${draftId}` })).statusCode
      ).toBe(404);
      expect(await minting.app.sweepExpiredDrafts()).toMatchObject({ deleted: 1 });

      // And pinning stays an operator's act — a self-service token cannot buy
      // itself the exemption either.
      const secondDraftId = await minting.uploadAs(token, "Minted and hopeful");
      const selfPin = await minting.app.inject({
        method: "POST",
        url: `/api/drafts/${secondDraftId}/pin`,
        headers: { authorization: `Bearer ${token}` }
      });
      expect(selfPin.statusCode).toBe(403);
    } finally {
      await minting.close();
    }
  });
});

interface ServedDraft {
  app: ReturnType<typeof createApp>;
  /** The store behind the app, for reading what a request left behind. */
  db: JsonFilePatchPageDb;
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
    db,
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
  storage: FileSystemHtmlStorage;
  /** Where this app's HTML objects land, so a test can watch them go. */
  storageDir: string;
  advanceDays(days: number): void;
  close(): Promise<void>;
};

type ClockedAppOptions = {
  openDb?: (file: string, clock: () => number) => JsonFilePatchPageDb;
  openStorage?: (storageDir: string) => FileSystemHtmlStorage;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** The pinned mint route, spelled out here rather than imported from the app. */
const MINT_PATH = "/api/tokens/self-service";

/**
 * A refusal body with `error` checked and removed, so the caller can assert the
 * rest of the pinned shape exactly.
 *
 * Every pinned refusal carries `error`, but its wording is copy that should be
 * free to improve; what must not drift is that the field is there and says
 * something. Lifting it out here lets the assertions use `toEqual` — which
 * catches a field quietly appearing or vanishing — instead of `toMatchObject`,
 * which would wave both through.
 */
function refusalBody(response: InjectedResponse): Record<string, unknown> {
  const body = response.json() as Record<string, unknown>;
  expect(typeof body.error).toBe("string");
  expect((body.error as string).length).toBeGreaterThan(0);

  const pinned = { ...body };
  delete pinned.error;
  return pinned;
}

type MintedToken = { token: string; accountId: string };
type InjectedResponse = Awaited<ReturnType<ReturnType<typeof createApp>["inject"]>>;

interface MintApp {
  readonly app: ReturnType<typeof createApp>;
  readonly dbFile: string;
  mint(sourceIp: string): Promise<InjectedResponse>;
  /** Mints, then reads back the principal the token authenticates as. */
  mintedToken(sourceIp: string): Promise<MintedToken>;
  uploadAs(token: string, title: string): Promise<string>;
  advanceMs(ms: number): void;
  /** Drops the process and opens a new one over the same stored state. */
  restart(): Promise<void>;
  close(): Promise<void>;
}

/**
 * An app for the mint route, with a clock both it and its database read, and a
 * restart that keeps the stored state while discarding everything in memory —
 * which is the only way to tell the durable half of the mint guardrail from the
 * per-minute half.
 */
async function createMintApp(
  label: string,
  overrides: Partial<ServerConfig> = {}
): Promise<MintApp> {
  let now = Date.UTC(2026, 0, 1);
  const clock = (): number => now;
  const dbFile = path.join(tempDir, `${label}-db.json`);
  const storage = new FileSystemHtmlStorage(path.join(tempDir, `${label}-drafts`));
  const config: ServerConfig = {
    ...testConfig(),
    allowSelfServiceTokens: true,
    jsonDbFile: dbFile,
    ...overrides
  };

  const open = async (): Promise<{
    app: ReturnType<typeof createApp>;
    db: JsonFilePatchPageDb;
  }> => {
    const db = new JsonFilePatchPageDb(dbFile, { clock });
    await db.initialize("dev-token");
    return { app: createApp({ config, db, storage, clock }), db };
  };

  let running = await open();

  return {
    get app() {
      return running.app;
    },
    dbFile,
    async mint(sourceIp) {
      return running.app.inject({
        method: "POST",
        url: MINT_PATH,
        headers: { "content-type": "application/json" },
        payload: "{}",
        remoteAddress: sourceIp
      });
    },
    async mintedToken(sourceIp) {
      const mint = await this.mint(sourceIp);
      expect(mint.statusCode).toBe(201);
      const token = (mint.json() as { token: string }).token;

      const me = await running.app.inject({
        method: "GET",
        url: "/api/me",
        headers: { authorization: `Bearer ${token}` }
      });
      expect(me.statusCode).toBe(200);
      return { token, accountId: (me.json() as { accountId: string }).accountId };
    },
    async uploadAs(token, title) {
      const upload = await running.app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          html: `<!doctype html><html><head><title>${title}</title></head><body></body></html>`
        }
      });
      expect(upload.statusCode).toBe(201);
      return (upload.json() as { draftId: string }).draftId;
    },
    advanceMs(ms) {
      now += ms;
    },
    async restart() {
      await running.app.close();
      await running.db.close();
      running = await open();
    },
    async close() {
      await running.app.close();
      await running.db.close();
    }
  };
}

/**
 * An app whose clock can be wound forward months. The database gets the *same*
 * clock: the retention clock is the database's, so an app-only clock would move
 * the rate limiters and nothing else.
 */
async function createClockedApp(
  label: string,
  options: ClockedAppOptions = {}
): Promise<ClockedApp> {
  const openDb =
    options.openDb ?? ((file, clock) => new JsonFilePatchPageDb(file, { clock }));
  const openStorage = options.openStorage ?? ((dir) => new FileSystemHtmlStorage(dir));
  let now = Date.UTC(2026, 0, 1);
  const clock = (): number => now;
  const db = openDb(path.join(tempDir, `${label}-db.json`), clock);
  await db.initialize("dev-token");
  const storageDir = path.join(tempDir, `${label}-drafts`);
  const storage = openStorage(storageDir);
  const app = createApp({ config: testConfig(), db, storage, clock });

  return {
    app,
    storage,
    storageDir,
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
    allowSelfServiceTokens: false,
    maxHtmlBytes: 512 * 1024,
    protectedApiRateLimitPerMinute: 60,
    authenticatedUploadRateLimitPerMinute: 20,
    selfServiceMintRateLimitPerMinute: 5,
    selfServiceMintsPerIpPerDay: 5,
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
