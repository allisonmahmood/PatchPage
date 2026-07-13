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
import {
  createRateLimiters,
  type FixedWindowRateLimiter,
  type RateLimitDecision
} from "./rate-limit.js";
import { renderDraftWrapper, renderHome, renderNotFound } from "./render.js";

export interface CreateAppOptions {
  config: ServerConfig;
  db: PatchPageDb;
  storage: HtmlStorage;
  clock?: () => number;
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
    authState?: ApiRequestAuthState;
    preBodyAuthorizedScopes?: Set<string>;
    preBodyUploadLimiterConsumed?: boolean;
  }
}

type ApiRequestAuthState =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "authenticated"; auth: ApiTokenAuth };

export type AuthorizationCredential =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "bearer"; token: string };

interface ProtectedApiHookOptions {
  uploadLimiter?: FixedWindowRateLimiter;
}

type ApiPolicyScope = "admin" | "upload";

type ApiRequestTargetPolicy =
  | { protected: false }
  | { protected: true; requiredScope?: ApiPolicyScope; uploadLimit?: boolean };

export function createApp(options: CreateAppOptions): FastifyInstance {
  const rateLimiters = createRateLimiters(options.config, { clock: options.clock });
  const app = Fastify({
    logger: false,
    bodyLimit: Math.max(options.config.maxHtmlBytes * 3, 2 * 1024 * 1024),
    trustProxy: options.config.trustProxy
  });

  app.addHook("onSend", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Cache-Control", "no-store");
  });

  app.addHook(
    "onRequest",
    protectedApiPrefixGuard(options.db, rateLimiters.protectedApi, rateLimiters.authenticatedUpload)
  );

  const protectedApi = (requiredScope?: string, hookOptions: ProtectedApiHookOptions = {}) =>
    protectedApiRouteHook(requiredScope, hookOptions);

  app.get("/", async (_request, reply) => {
    return reply.type("text/html").send(renderHome({ publicBaseUrl: options.config.publicBaseUrl }));
  });

  app.get("/healthz", async () => ({ ok: true }));

  app.get("/api/me", { onRequest: protectedApi() }, async (request) => {
    const auth = authenticatedRequest(request);

    return {
      accountId: auth.accountId,
      accountName: auth.accountName,
      apiTokenId: auth.id,
      apiTokenName: auth.name,
      scopes: auth.scopes
    };
  });

  app.post("/api/tokens", { onRequest: protectedApi("admin") }, async (request, reply) => {
    const auth = authenticatedRequest(request);

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

  app.post(
    "/api/uploads",
    { onRequest: protectedApi("upload", { uploadLimiter: rateLimiters.authenticatedUpload }) },
    async (request, reply) => {
      const auth = authenticatedRequest(request);

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
    }
  );

  app.post(
    "/api/drafts/:draftId/disable",
    { onRequest: protectedApi() },
    async (request, reply) => {
      const auth = authenticatedRequest(request);

      const draftId = (request.params as { draftId: string }).draftId;
      const reason =
        cleanText((request.body as { reason?: unknown } | null)?.reason) || "Disabled.";
      const disabled = await options.db.disableDraft(draftId, auth.accountId, reason);
      if (!disabled) return reply.status(404).send({ ok: false, error: "Draft not found." });
      return { ok: true };
    }
  );

  app.delete(
    "/api/drafts/:draftId",
    { onRequest: protectedApi() },
    async (request, reply) => {
      const auth = authenticatedRequest(request);

      const draftId = (request.params as { draftId: string }).draftId;
      const deleted = await options.db.deleteDraft(draftId, auth.accountId);
      if (!deleted) return reply.status(404).send({ ok: false, error: "Draft not found." });
      return { ok: true };
    }
  );

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

function protectedApiPrefixGuard(
  db: PatchPageDb,
  protectedApiLimiter: FixedWindowRateLimiter,
  authenticatedUploadLimiter: FixedWindowRateLimiter
) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const targetPolicy = classifyApiRequestTargetPolicy(request.url);
    if (!targetPolicy.protected) return;

    const protectedAttempt = protectedApiLimiter.consume(request.ip);
    if (!protectedAttempt.allowed) {
      sendRateLimited(reply, protectedAttempt);
      return;
    }

    const authState = await authenticateApiRequest(db, request);
    request.authState = authState;

    if (authState.kind === "missing" || authState.kind === "invalid") {
      reply.status(401).send({ ok: false, error: "Missing or invalid API token." });
      return;
    }

    request.auth = authState.auth;

    if (targetPolicy.requiredScope) {
      if (!hasScope(authState.auth, targetPolicy.requiredScope)) {
        reply.status(403).send({ ok: false, error: "API token does not have the required scope." });
        return;
      }
      markPreBodyAuthorizedScope(request, targetPolicy.requiredScope);
    }

    if (targetPolicy.uploadLimit) {
      const uploadAttempt = authenticatedUploadLimiter.consume(authState.auth.id);
      request.preBodyUploadLimiterConsumed = true;
      if (!uploadAttempt.allowed) {
        sendRateLimited(reply, uploadAttempt);
        return;
      }
    }

    if (request.is404) {
      sendApiNotFound(reply);
      return;
    }
  };
}

function protectedApiRouteHook(requiredScope: string | undefined, options: ProtectedApiHookOptions) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const auth = request.auth;
    if (!auth) {
      reply.status(401).send({ ok: false, error: "Missing or invalid API token." });
      return;
    }

    const scopeAlreadyChecked =
      requiredScope && request.preBodyAuthorizedScopes?.has(requiredScope);
    if (requiredScope && !scopeAlreadyChecked && !hasScope(auth, requiredScope)) {
      reply.status(403).send({ ok: false, error: "API token does not have the required scope." });
      return;
    }

    if (options.uploadLimiter && !request.preBodyUploadLimiterConsumed) {
      const uploadAttempt = options.uploadLimiter.consume(auth.id);
      request.preBodyUploadLimiterConsumed = true;
      if (!uploadAttempt.allowed) {
        sendRateLimited(reply, uploadAttempt);
        return;
      }
    }

    request.auth = auth;
  };
}

export function isProtectedApiPath(requestTarget: string): boolean {
  return classifyApiRequestTargetPolicy(requestTarget).protected;
}

function canonicalRequestTargetPath(requestTarget: string): string | null {
  const originForm = requestTarget.replace(/^https?:\/\/.*?\//, "/");
  const end = originForm.search(/[?#]/);
  const rawPath = end === -1 ? originForm : originForm.slice(0, end);
  const rawPathWithPolicySeparators = rawPath.replace(/%2f/gi, "/");

  try {
    return normalizePolicyPath(decodeURI(rawPathWithPolicySeparators));
  } catch {
    return null;
  }
}

function classifyApiRequestTargetPolicy(requestTarget: string): ApiRequestTargetPolicy {
  const pathname = canonicalRequestTargetPath(requestTarget);
  if (pathname === null) return { protected: true };
  if (pathname === "/api/uploads") {
    return { protected: true, requiredScope: "upload", uploadLimit: true };
  }
  if (pathname === "/api/tokens") {
    return { protected: true, requiredScope: "admin" };
  }
  return {
    protected: pathname === "/api" || pathname.startsWith("/api/")
  };
}

function normalizePolicyPath(pathname: string): string {
  const collapsed = pathname.replace(/\/+/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/+$/g, "") : collapsed;
}

function hasScope(auth: ApiTokenAuth, scope: string): boolean {
  return auth.scopes.includes(scope) || auth.scopes.includes("admin");
}

function markPreBodyAuthorizedScope(request: FastifyRequest, scope: string): void {
  request.preBodyAuthorizedScopes ??= new Set();
  request.preBodyAuthorizedScopes.add(scope);
}

function sendRateLimited(reply: FastifyReply, decision: RateLimitDecision): void {
  const retryAfterSeconds = decision.retryAfterSeconds ?? 1;
  reply.header("Retry-After", String(retryAfterSeconds));
  reply.status(429).send({
    ok: false,
    error: "Rate limit exceeded.",
    code: "rate_limited",
    retryAfterSeconds
  });
}

function sendApiNotFound(reply: FastifyReply): void {
  reply.status(404).send({
    ok: false,
    error: "Not found."
  });
}

async function authenticateApiRequest(
  db: PatchPageDb,
  request: FastifyRequest
): Promise<ApiRequestAuthState> {
  const credential = authorizationCredential(request);
  if (credential.kind === "missing") return { kind: "missing" };
  if (credential.kind === "invalid") return { kind: "invalid" };

  const auth = await db.findApiTokenByToken(credential.token);
  return auth ? { kind: "authenticated", auth } : { kind: "invalid" };
}

function authorizationCredential(
  request: FastifyRequest
): AuthorizationCredential {
  return classifyAuthorizationHeader(request.headers.authorization);
}

export function classifyAuthorizationHeader(
  authHeader: string | undefined
): AuthorizationCredential {
  if (authHeader === undefined) return { kind: "missing" };

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token ? { kind: "bearer", token } : { kind: "invalid" };
}

function authenticatedRequest(request: FastifyRequest): ApiTokenAuth {
  if (!request.auth) {
    throw new Error("Authenticated request is missing API token auth state.");
  }
  return request.auth;
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
