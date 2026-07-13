import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import Fastify from "fastify";
import type { ServerConfig } from "@patchpage/config";
import { isUploadTargetError } from "@patchpage/db";
import type {
  ApiTokenAuth,
  PatchPageDb,
  RecordUploadInput,
  RecordUploadResult
} from "@patchpage/db";
import type { HtmlStorage } from "@patchpage/storage";
import {
  contentHash,
  isDraftId,
  newDraftId,
  newInternalId,
  randomToken,
  validateHtml
} from "@patchpage/core";
import type { UploadMetadata } from "@patchpage/core";
import { getDraftPublicUrl } from "./public-url.js";
import { renderDraftWrapper, renderHome, renderNotFound } from "./render.js";

export interface CreateAppOptions {
  config: ServerConfig;
  db: PatchPageDb;
  storage: HtmlStorage;
}

interface UploadBody {
  html?: unknown;
  filename?: unknown;
  draftId?: unknown;
  metadata?: unknown;
}

interface TokenBody {
  name?: unknown;
  scopes?: unknown;
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: ApiTokenAuth;
  }
}

export function createApp(options: CreateAppOptions): FastifyInstance {
  const app = Fastify({
    logger: false,
    bodyLimit: Math.max(options.config.maxHtmlBytes * 3, 2 * 1024 * 1024),
    trustProxy: options.config.trustProxy
  });

  app.addHook("onSend", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Cache-Control", "no-store");
  });

  app.get("/", async (_request, reply) => {
    return reply.type("text/html").send(renderHome({ publicBaseUrl: options.config.publicBaseUrl }));
  });

  app.get("/healthz", async () => ({ ok: true }));

  app.get("/api/me", async (request, reply) => {
    const auth = await requireAuth(options.db, request, reply);
    if (!auth) return;

    return {
      accountId: auth.accountId,
      accountName: auth.accountName,
      apiTokenId: auth.id,
      apiTokenName: auth.name,
      scopes: auth.scopes
    };
  });

  app.post("/api/tokens", async (request, reply) => {
    const auth = await requireAuth(options.db, request, reply, "admin");
    if (!auth) return;

    const body = (request.body || {}) as TokenBody;
    const token = `pp_${randomToken(32)}`;
    const scopes = normalizeScopes(body.scopes);
    const apiToken = await options.db.createApiToken({
      accountId: auth.accountId,
      name: cleanText(body.name) || "CLI API Token",
      token,
      scopes
    });

    return reply.status(201).send({
      ok: true,
      apiToken,
      token
    });
  });

  app.post("/api/uploads", async (request, reply) => {
    const auth = await requireAuth(options.db, request, reply, "upload");
    if (!auth) return;

    const body = (request.body || {}) as UploadBody;
    if (typeof body.html !== "string") {
      return reply.status(400).send({ ok: false, error: "Missing HTML document." });
    }
    const html = body.html;

    const validation = validateHtml(html, { maxBytes: options.config.maxHtmlBytes });
    if (!validation.ok) {
      return reply.status(422).send({
        ok: false,
        errors: validation.errors,
        warnings: validation.warnings
      });
    }

    const requestedDraftId =
      body.draftId === undefined || body.draftId === null ? null : body.draftId;
    if (
      requestedDraftId !== null &&
      (typeof requestedDraftId !== "string" || !isDraftId(requestedDraftId))
    ) {
      return reply.status(400).send({ ok: false, error: "Invalid draft ID." });
    }

    const draftId = requestedDraftId || newDraftId();
    const versionId = newInternalId("ver");
    const objectKey = `drafts/${draftId}/versions/${versionId}.html`;
    const filename = cleanText(body.filename);
    const metadata = normalizeMetadata(body.metadata);
    const title = validation.title || filename || "Untitled Draft";

    const uploadInput: RecordUploadInput = {
      intent: requestedDraftId ? "update" : "create",
      draftId,
      versionId,
      accountId: auth.accountId,
      apiTokenId: auth.id,
      title,
      objectKey,
      contentHash: contentHash(html),
      fileSize: Buffer.byteLength(html, "utf8"),
      filename,
      metadata,
      sourceIp: request.ip || null,
      userAgent: request.headers["user-agent"] || null
    };

    await options.db.assertUploadTarget(uploadInput);
    await options.storage.putHtmlObject(objectKey, html);

    let upload: RecordUploadResult;
    try {
      upload = await options.db.recordUpload(uploadInput);
    } catch (error) {
      if (!isUploadTargetError(error)) throw error;
      try {
        await options.storage.deleteHtmlObject(objectKey);
      } catch (cleanupError) {
        app.log.error(cleanupError);
        throw new Error("Upload cleanup failed.");
      }
      throw error;
    }

    const publicUrl = getDraftPublicUrl({
      draftId,
      publicBaseUrl: options.config.publicBaseUrl
    });

    return reply.status(requestedDraftId ? 200 : 201).send({
      ok: true,
      ...upload,
      publicUrl,
      warnings: validation.warnings
    });
  });

  app.post("/api/drafts/:draftId/disable", async (request, reply) => {
    const auth = await requireAuth(options.db, request, reply);
    if (!auth) return;

    const draftId = (request.params as { draftId: string }).draftId;
    const reason = cleanText((request.body as { reason?: unknown } | null)?.reason) || "Disabled.";
    const disabled = await options.db.disableDraft(draftId, auth.accountId, reason);
    if (!disabled) return reply.status(404).send({ ok: false, error: "Draft not found." });
    return { ok: true };
  });

  app.delete("/api/drafts/:draftId", async (request, reply) => {
    const auth = await requireAuth(options.db, request, reply);
    if (!auth) return;

    const draftId = (request.params as { draftId: string }).draftId;
    const deleted = await options.db.deleteDraft(draftId, auth.accountId);
    if (!deleted) return reply.status(404).send({ ok: false, error: "Draft not found." });
    return { ok: true };
  });

  app.get("/d/:draftId", async (request, reply) => {
    const draftId = (request.params as { draftId: string }).draftId;
    return renderDraft(options, draftId, undefined, reply);
  });

  app.get("/d/:draftId/v/:versionNumber", async (request, reply) => {
    const params = request.params as { draftId: string; versionNumber: string };
    return renderDraft(options, params.draftId, Number(params.versionNumber), reply);
  });

  app.setNotFoundHandler((_request, reply) => {
    return reply.status(404).type("text/html").send(renderNotFound());
  });

  app.setErrorHandler((error, _request, reply) => {
    const typedError = error as Error & { statusCode?: number };
    const statusCode = typedError.statusCode || 500;
    const message = statusCode >= 500 ? "Internal server error." : typedError.message;
    if (statusCode >= 500) {
      app.log.error(error);
    }
    return reply.status(statusCode).send({ ok: false, error: message });
  });

  return app;
}

async function renderDraft(
  options: CreateAppOptions,
  draftId: string,
  versionNumber: number | undefined,
  reply: FastifyReply
): Promise<void> {
  const { draft, version } = await options.db.findDraftVersion(draftId, versionNumber);
  if (!draft || !version) {
    return reply.status(404).type("text/html").send(renderNotFound());
  }

  const html = await options.storage.getHtmlObject(version.objectKey);
  reply.header(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      "img-src https: data:",
      "frame-src 'self' about:",
      "base-uri 'none'",
      "form-action 'none'"
    ].join("; ")
  );
  return reply.type("text/html").send(
    renderDraftWrapper({
      draft,
      version,
      html,
      homeUrl: options.config.publicBaseUrl
    })
  );
}

async function requireAuth(
  db: PatchPageDb,
  request: FastifyRequest,
  reply: FastifyReply,
  requiredScope?: string
): Promise<ApiTokenAuth | null> {
  const authHeader = request.headers.authorization || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  if (!token) {
    reply.status(401).send({ ok: false, error: "Missing or invalid API token." });
    return null;
  }

  const auth = await db.findApiTokenByToken(token);
  if (!auth) {
    reply.status(401).send({ ok: false, error: "Missing or invalid API token." });
    return null;
  }

  if (requiredScope && !auth.scopes.includes(requiredScope) && !auth.scopes.includes("admin")) {
    reply.status(403).send({ ok: false, error: "API token does not have the required scope." });
    return null;
  }

  request.auth = auth;
  return auth;
}

function normalizeMetadata(value: unknown): UploadMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return {
    repoOrg: cleanText((value as Record<string, unknown>).repoOrg),
    repoName: cleanText((value as Record<string, unknown>).repoName),
    gitBranch: cleanText((value as Record<string, unknown>).gitBranch),
    gitCommitSha: cleanText((value as Record<string, unknown>).gitCommitSha),
    cliVersion: cleanText((value as Record<string, unknown>).cliVersion),
    fileSha256: cleanText((value as Record<string, unknown>).fileSha256)
  };
}

function normalizeScopes(value: unknown): string[] {
  if (!Array.isArray(value)) return ["upload"];
  const scopes = value.map((scope) => cleanText(scope)).filter(isString);
  return scopes.length ? [...new Set(scopes)] : ["upload"];
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 255) : null;
}

function isString(value: string | null): value is string {
  return typeof value === "string";
}
