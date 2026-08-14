import type { IncomingMessage } from "node:http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import Fastify from "fastify";
import { ACCEPTABLE_USE_URL } from "@patchpage/config";
import type { ServerConfig } from "@patchpage/config";
import { isUploadTargetError } from "@patchpage/db";
import type {
  ApiTokenAuth,
  DraftRecord,
  ModeratedDraftRecord,
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
import { DisabledAnalytics, type Analytics } from "./analytics.js";
import { createExpirySweep, type ExpirySweepResult } from "./expiry-sweep.js";
import { getDraftPublicUrl } from "./public-url.js";
import {
  createRateLimiters,
  type FixedWindowRateLimiter,
  type RateLimitDecision
} from "./rate-limit.js";
import {
  renderDraftReportAcknowledgement,
  renderDraftReportForm,
  renderDraftWrapper,
  renderHome,
  renderNotFound
} from "./render.js";
import {
  DRAFT_CONTENT_SECURITY_POLICY,
  DRAFT_ROBOTS_TAG,
  NO_REFERRER_POLICY,
  NO_STORE_CACHE_CONTROL,
  REPORT_PAGE_CONTENT_SECURITY_POLICY,
  servedDraftCacheControl
} from "./serving-headers.js";

export interface CreateAppOptions {
  config: ServerConfig;
  db: PatchPageDb;
  storage: HtmlStorage;
  clock?: () => number;
  /**
   * Where business events are reported. Left out, the app reports nothing —
   * which is what an instance with no analytics key configured runs with.
   */
  analytics?: Analytics;
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
  interface FastifyInstance {
    /**
     * Runs the expiry sweep once, against this app's clock. The app owns it so
     * that winding the clock forward and sweeping is one seam, and so that the
     * only thing left to schedule is the calling.
     */
    sweepExpiredDrafts(): Promise<ExpirySweepResult>;
  }

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
  | {
      protected: true;
      requiredScope?: ApiPolicyScope;
      uploadLimit?: boolean;
    };

/**
 * A report is one optional sentence, and the driver caps what it stores at 255
 * characters anyway. Refusing an oversized body outright keeps an
 * unauthenticated write from being a place to push bytes.
 */
const REPORT_FORM_BODY_LIMIT_BYTES = 8 * 1024;

/**
 * Self-service minting's route. Deliberately under `/api/tokens/` and just as
 * deliberately not `/api/tokens`: the admin token-creation endpoint keeps its
 * name, its body, and its admin-only posture, and this is a different operation
 * with a different audience — zero input, no credential, its own guardrails.
 *
 * It is the service's other unauthenticated write, alongside the report path.
 */
const SELF_SERVICE_MINT_PATH = "/api/tokens/self-service";

const FASTIFY_DEFAULT_MAX_PARAM_LENGTH = 100;
/**
 * The `POST /api/drafts/:draftId/<suffix>` routes that exist. An overlong
 * parameter on one of these is a too-long target; on anything else it is a
 * route that was never there. Adding a route here without adding it below
 * turns its overlong-parameter answer into a 404.
 */
const REGISTERED_DRAFT_POST_SUFFIXES = new Set(["disable", "pin", "unpin"]);
/**
 * How many of a principal's drafts one moderation list read returns, newest
 * first. A truncated answer says so rather than pretending to be whole.
 *
 * The list omits deleted drafts and keeps disabled ones, so *deleting* is the
 * only act that drains a page of results: work the page, read again, see the
 * rest. Disabling takes a draft out of service and leaves it on this list —
 * which is right, because a disabled draft is still one the operator may want
 * to come back and delete.
 */
const MODERATION_DRAFT_LIST_LIMIT = 200;
const PRE_ROUTING_API_ERROR_TARGET = "/api/__patchpage_pre_routing_error__";
const preRoutingApiErrorStatus = Symbol("preRoutingApiErrorStatus");

type PreRoutingApiErrorStatus = 400 | 404 | 414;
type MarkedIncomingMessage = IncomingMessage & {
  [preRoutingApiErrorStatus]?: PreRoutingApiErrorStatus;
};

export function createApp(options: CreateAppOptions): FastifyInstance {
  const clock = options.clock ?? Date.now;
  const rateLimiters = createRateLimiters(options.config, { clock: options.clock });
  const app = Fastify({
    logger: false,
    bodyLimit: Math.max(options.config.maxHtmlBytes * 3, 2 * 1024 * 1024),
    trustProxy: options.config.trustProxy,
    rewriteUrl: rewriteProtectedApiRoutingFailure
  });

  app.addHook("onSend", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    // Served drafts set their own cache policy; everything else stays uncached.
    if (!reply.hasHeader("Cache-Control")) {
      reply.header("Cache-Control", NO_STORE_CACHE_CONTROL);
    }
  });

  app.addHook(
    "onRequest",
    protectedApiPrefixGuard(
      options.db,
      rateLimiters.protectedApi,
      rateLimiters.authenticatedUpload
    )
  );

  const protectedApi = (requiredScope?: string, hookOptions: ProtectedApiHookOptions = {}) =>
    protectedApiRouteHook(requiredScope, hookOptions);

  const analytics = options.analytics ?? new DisabledAnalytics(app.log);

  const expirySweep = createExpirySweep({
    db: options.db,
    storage: options.storage,
    analytics,
    log: app.log
  });
  app.decorate("sweepExpiredDrafts", () => expirySweep.run());

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

    // A token minted is a token minted, whichever door it came through. The
    // flag is what tells the operator's own issuing apart from the self-service
    // flow, so the event list stays one narrative rather than two.
    analytics.capture({
      name: "token.minted",
      principalId: auth.accountId,
      properties: { apiTokenId: apiToken.id, selfService: false }
    });

    return reply.status(201).send({
      ok: true,
      apiToken,
      token
    });
  });

  // The mint route parses its own body. The operation takes no input at all, so
  // both an absent body and `{}` have to be accepted — and Fastify's stock JSON
  // parser rejects the absent one whenever the client still sends the JSON
  // content-type, which is the shape the CLI's auto-mint actually puts on the
  // wire. Encapsulated in its own scope so no other route's body handling
  // moves: an upload that arrives empty must keep failing exactly as it does.
  app.register(async (mintScope) => {
    mintScope.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      (_request, body: string, done) => {
        if (body.trim().length === 0) {
          done(null, {});
          return;
        }
        try {
          done(null, JSON.parse(body) as unknown);
        } catch {
          const malformed = new Error("Malformed JSON body.") as Error & {
            statusCode?: number;
          };
          malformed.statusCode = 400;
          done(malformed);
        }
      }
    );

    mintScope.post(SELF_SERVICE_MINT_PATH, async (request, reply) =>
      mintSelfServiceToken(
        options,
        analytics,
        rateLimiters.selfServiceMint,
        clock,
        request,
        reply
      )
    );
  });

  // Revocation is the moderation loop's last step and its only irreversible
  // one. It sets a state, never deletes: the row survives with its mint
  // provenance, the token's drafts stay up until expiry with their top-ups
  // frozen, and the token itself becomes indistinguishable from a bad one on
  // every route. There is no un-revoke — a replacement is a fresh mint.
  app.post(
    "/api/tokens/:apiTokenId/revoke",
    { onRequest: protectedApi("admin") },
    async (request, reply) => {
      const apiTokenId = (request.params as { apiTokenId: string }).apiTokenId;
      const revocation = await options.db.revokeApiToken(apiTokenId);
      if (!revocation) {
        return reply.status(404).send({ ok: false, error: "API token not found." });
      }

      // Idempotent: revoking twice is the same answer, with the original
      // moment intact, because that moment is when the freeze began.
      return {
        ok: true,
        alreadyRevoked: revocation.alreadyRevoked,
        apiToken: {
          id: revocation.id,
          name: revocation.name,
          principalId: revocation.accountId,
          revokedAt: revocation.revokedAt
        }
      };
    }
  );

  // The moderation loop's first step: a reported URL, answered with the
  // principal behind it and the token to revoke. Admin-scoped, and deliberately
  // answering for drafts that are already disabled, deleted, or expired — the
  // operator is asked about pages that are off as often as pages that are on.
  app.get("/api/drafts/:draftId", { onRequest: protectedApi("admin") }, async (request, reply) => {
    const draftId = (request.params as { draftId: string }).draftId;
    const draft = await options.db.findDraftForModeration(draftId);
    if (!draft) return reply.status(404).send({ ok: false, error: "Draft not found." });
    return { ok: true, draft: moderationDraftView(draft) };
  });

  // The second step: everything else that principal is holding, so one report
  // resolves the whole principal rather than the single page that was flagged.
  app.get(
    "/api/principals/:principalId/drafts",
    { onRequest: protectedApi("admin") },
    async (request) => {
      const principalId = (request.params as { principalId: string }).principalId;
      const listing = await options.db.listDraftsByPrincipal(
        principalId,
        MODERATION_DRAFT_LIST_LIMIT
      );

      return {
        ok: true,
        principalId,
        drafts: listing.drafts.map(moderationDraftView),
        truncated: listing.truncated
      };
    }
  );

  app.post(
    "/api/uploads",
    {
      onRequest: protectedApi("upload", {
        uploadLimiter: rateLimiters.authenticatedUpload
      })
    },
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

      // Only creates are quota-bearing. An update rewrites a draft the token
      // already holds, so it costs nothing against either ceiling.
      if (requestedDraftId === null) {
        // The per-minute bucket is consumed before the quota is counted, so a
        // client parked at the quota is throttled instead of being free to
        // re-count the database at the higher upload-limit rate. The cost is
        // that such a client sees 403 flip to 429 once its bucket empties.
        const createAttempt = rateLimiters.draftCreate.consume(auth.id);
        if (!createAttempt.allowed) {
          sendRateLimited(reply, createAttempt);
          return reply;
        }

        // Recounted from the database every time, so the ceiling outlives a
        // restart. Concurrent creates can overshoot it by at most the burst the
        // per-minute limiter above allows through.
        const liveDrafts = await options.db.countLiveDraftsByCreatorApiToken(auth.id);
        if (liveDrafts >= options.config.liveDraftsPerToken) {
          return sendLiveDraftQuotaExceeded(reply, options.config.liveDraftsPerToken);
        }
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
          throw new Error("Upload cleanup failed.", { cause: cleanupError });
        }
        throw error;
      }

      const publicUrl = getDraftPublicUrl({
        draftId,
        publicBaseUrl: options.config.publicBaseUrl
      });

      // Reported once the upload is committed, so the event describes a draft
      // that exists. The size is the stored bytes, not the content.
      analytics.capture({
        name: requestedDraftId ? "draft.updated" : "draft.created",
        principalId: auth.accountId,
        properties: {
          draftId: upload.draftId,
          apiTokenId: auth.id,
          versionNumber: upload.versionNumber,
          htmlBytes: uploadInput.fileSize
        }
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
      const disabled = await options.db.disableDraft(draftId, auth.accountId, reason, {
        canModerateAnyPrincipal: hasScope(auth, "admin")
      });
      if (!disabled) return reply.status(404).send({ ok: false, error: "Draft not found." });

      analytics.capture({
        name: "draft.disabled",
        principalId: auth.accountId,
        properties: { draftId, admin: hasScope(auth, "admin") }
      });
      return { ok: true };
    }
  );

  // Pinning is an operator's act on the instance's own pages, so it is
  // admin-scoped and unowned: an admin pins any draft, whoever holds it. The
  // pin exempts the draft from expiry and changes nothing else about it.
  //
  // A pin only holds a draft that is in service, so pinning a deleted or
  // disabled one is a 404 — while unpinning works on anything still there.
  for (const route of [
    { suffix: "pin", pinned: true },
    { suffix: "unpin", pinned: false }
  ] as const) {
    app.post(
      `/api/drafts/:draftId/${route.suffix}`,
      { onRequest: protectedApi("admin") },
      async (request, reply) => {
        const draftId = (request.params as { draftId: string }).draftId;
        const applied = await options.db.setDraftPinned(draftId, route.pinned);
        if (!applied) return reply.status(404).send({ ok: false, error: "Draft not found." });
        return { ok: true, pinned: route.pinned };
      }
    );
  }

  app.delete(
    "/api/drafts/:draftId",
    { onRequest: protectedApi() },
    async (request, reply) => {
      const auth = authenticatedRequest(request);

      const draftId = (request.params as { draftId: string }).draftId;
      const deleted = await options.db.deleteDraft(draftId, auth.accountId, {
        canModerateAnyPrincipal: hasScope(auth, "admin")
      });
      if (!deleted) return reply.status(404).send({ ok: false, error: "Draft not found." });

      analytics.capture({
        name: "draft.deleted",
        principalId: auth.accountId,
        properties: { draftId, admin: hasScope(auth, "admin") }
      });
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

  // The report path, in its own encapsulated scope so its form-body parser
  // belongs to it alone: adding a urlencoded parser to the root instance would
  // quietly change how every `/api` route answers a form-encoded body.
  app.register(async (reportScope) => {
    reportScope.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string", bodyLimit: REPORT_FORM_BODY_LIMIT_BYTES },
      (_request, body, done) => {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      }
    );

    reportScope.get("/report/:draftId", async (request, reply) => {
      const draftId = (request.params as { draftId: string }).draftId;
      const draft = await findReportableDraft(options, draftId);
      if (!draft) return sendDraftNotFound(reply);

      applyReportPageHeaders(reply);
      return reply
        .type("text/html")
        .send(renderDraftReportForm({ draft, publicBaseUrl: options.config.publicBaseUrl }));
    });

    reportScope.post("/report/:draftId", async (request, reply) => {
      // Before the draft lookup, not after: the limiter is here so a flood of
      // reports costs the instance neither a read nor a row. It answers in the
      // same rate-limited shape every other limiter here does — one contract
      // for one rejection — and being limited says nothing about the page: a
      // report has no automatic consequence at any volume.
      const reportAttempt = rateLimiters.report.consume(request.ip || "");
      if (!reportAttempt.allowed) {
        sendRateLimited(reply, reportAttempt);
        return reply;
      }

      const draftId = (request.params as { draftId: string }).draftId;
      const draft = await findReportableDraft(options, draftId);
      if (!draft) return sendDraftNotFound(reply);

      // Storing the report is the entire effect. Nothing here disables the
      // draft, shortens its clock, or touches its token: a page comes down
      // only when an operator decides it should, so filing the same report a
      // thousand times changes exactly as much as filing it once.
      const reason = cleanText((request.body as { reason?: unknown } | null)?.reason);
      await options.db.recordDraftReport({
        draftId: draft.id,
        sourceIp: request.ip || null,
        reason
      });

      // The event belongs to the principal whose draft was flagged, never to
      // the reader who flagged it: no address, and whether a reason was typed
      // rather than what it said.
      analytics.capture({
        name: "draft.reported",
        principalId: draft.accountId,
        properties: { draftId: draft.id, reasonGiven: reason !== null }
      });

      applyReportPageHeaders(reply);
      return reply
        .type("text/html")
        .send(
          renderDraftReportAcknowledgement({
            draft,
            publicBaseUrl: options.config.publicBaseUrl
          })
        );
    });
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

/**
 * Self-service minting: the zero-input operation that hands a caller a token
 * and the fresh principal that token controls.
 *
 * Three refusals guard it, and the order they run in is the point. The enabled
 * flag first, because a private instance owes an unauthenticated caller nothing
 * but "no". The per-minute rate next, before the quota is counted, for the same
 * reason draft creates do it in that order: a caller parked at the daily
 * ceiling should be throttled rather than left free to re-count the database as
 * fast as it can ask. The daily quota last, because it is the expensive one.
 */
async function mintSelfServiceToken(
  options: CreateAppOptions,
  analytics: Analytics,
  mintLimiter: FixedWindowRateLimiter,
  clock: () => number,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  if (!options.config.allowSelfServiceTokens) {
    return reply.status(403).send({
      ok: false,
      error:
        "This instance does not issue self-service tokens. Ask its operator for a token.",
      code: "self_service_disabled"
    });
  }

  const sourceIp = request.ip || null;

  const mintAttempt = mintLimiter.consume(sourceIp ?? "");
  if (!mintAttempt.allowed) {
    sendRateLimited(reply, mintAttempt);
    return reply;
  }

  // Recounted from the database on every mint, so the ceiling outlives a
  // restart. Concurrent mints can overshoot it by at most the burst the
  // per-minute limiter above lets through.
  const quota = options.config.selfServiceMintsPerIpPerDay;
  const recentMints = await options.db.countSelfServiceMintsBySourceIp(sourceIp);
  if (recentMints >= quota) {
    return reply.status(429).send({
      ok: false,
      // "Within a day", not "tomorrow": the window rolls off each mint 24 hours
      // after it happened, so the next slot opens on the oldest mint's clock
      // rather than at midnight.
      error: `Mint quota reached: ${quota} self-service tokens per address per 24 hours. Reuse the token you already hold, or retry once the oldest of those mints is a day old.`,
      code: "mint_quota_exceeded",
      quota
    });
  }

  const token = `pp_${randomToken(32)}`;
  const minted = await options.db.mintSelfServiceToken({
    token,
    name: selfServiceTokenName(clock()),
    sourceIp
  });

  // The principal and its token, and nothing about where the mint came from:
  // the source address is what the mint quota counts and what the mint record
  // keeps, not something to report.
  analytics.capture({
    name: "token.minted",
    principalId: minted.accountId,
    properties: { apiTokenId: minted.apiTokenId, selfService: true }
  });

  // The plaintext appears here and nowhere else, exactly once. Only its hash is
  // stored, so no later response — and no operator — can produce it again.
  return reply.status(201).send({
    ok: true,
    token,
    aupUrl: ACCEPTABLE_USE_URL
  });
}

/**
 * The internal name a mint assigns its principal and token. The client chooses
 * nothing here — the operation takes no input — so the mint date is what makes
 * the row legible to an operator reading the table later.
 */
function selfServiceTokenName(now: number): string {
  return `Self-service token ${new Date(now).toISOString().slice(0, 10)}`;
}

async function renderDraft(
  options: CreateAppOptions,
  draftId: string,
  versionNumber: number | undefined,
  reply: FastifyReply
): Promise<void> {
  reply.header("X-Robots-Tag", DRAFT_ROBOTS_TAG);
  reply.header("Referrer-Policy", NO_REFERRER_POLICY);

  const { draft, version } = await options.db.findDraftVersion(draftId, versionNumber);
  if (!draft || !version) {
    return reply.status(404).type("text/html").send(renderNotFound());
  }

  const html = await options.storage.getHtmlObject(version.objectKey);
  // The page is real and already fetched, so this is a visit — the thing that
  // keeps a draft people still visit from ageing out. The database decides
  // whether the clock actually moves and writes nothing when it does not.
  //
  // Best-effort on purpose: this is a read path, and a reader who is one header
  // away from their page should get it even if the top-up write fails. Losing a
  // clock extension costs at most some retention; turning a fetched page into a
  // 500 costs the reader the page itself.
  //
  // Only requests that reach the server are visits, and the cache headers below
  // mean repeat reads inside the latest URL's window may not. That undercount is
  // harmless: topping up needs one visit somewhere in the final stretch of a
  // 30-day window, not a true read count — this is a retention clock, not
  // analytics.
  try {
    await options.db.recordDraftVisit(draft.id);
  } catch (error) {
    reply.log.warn({ err: error, draftId: draft.id }, "Draft visit top-up failed.");
  }
  reply.header("Content-Security-Policy", DRAFT_CONTENT_SECURITY_POLICY);
  reply.header("Cache-Control", servedDraftCacheControl(versionNumber));
  return reply.type("text/html").send(
    renderDraftWrapper({
      draft,
      version,
      html,
      homeUrl: options.config.publicBaseUrl
    })
  );
}

/**
 * The draft a report is about, or nothing. You can only report a page you could
 * have read: the same lookup that serves a draft decides this, so a deleted,
 * disabled, or expired draft answers 404 here exactly as its URL does — and an
 * unknown ID is never a way to write a row.
 *
 * Deliberately not a visit: opening the report page is not a reading of the
 * draft, so it must not top the retention clock up.
 */
async function findReportableDraft(
  options: CreateAppOptions,
  draftId: string
): Promise<DraftRecord | null> {
  if (!isDraftId(draftId)) return null;
  const { draft } = await options.db.findDraftVersion(draftId);
  return draft;
}

/**
 * Report pages are first-party pages on the serving host, and they keep the
 * serving guarantees: noindexed, never cached, no cookie, and no script source
 * in their policy. Only the form-action differs from a served draft's, and only
 * on this page — see `REPORT_PAGE_CONTENT_SECURITY_POLICY`.
 */
function applyReportPageHeaders(reply: FastifyReply): void {
  reply.header("X-Robots-Tag", DRAFT_ROBOTS_TAG);
  reply.header("Referrer-Policy", NO_REFERRER_POLICY);
  reply.header("Content-Security-Policy", REPORT_PAGE_CONTENT_SECURITY_POLICY);
  // `Cache-Control` is left to the global hook, which makes it `no-store`.
}

function sendDraftNotFound(reply: FastifyReply): FastifyReply {
  reply.header("X-Robots-Tag", DRAFT_ROBOTS_TAG);
  reply.header("Referrer-Policy", NO_REFERRER_POLICY);
  return reply.status(404).type("text/html").send(renderNotFound());
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

    // No configuration admits a tokenless request: a missing credential and a
    // present-but-invalid one are indistinguishable from here on.
    if (authState.kind === "missing" || authState.kind === "invalid") {
      reply.status(401).send({ ok: false, error: "Missing or invalid API token." });
      return;
    }

    request.auth = authState.auth;

    const routingErrorStatus = (request.raw as MarkedIncomingMessage)[
      preRoutingApiErrorStatus
    ];
    if (routingErrorStatus) {
      sendPreRoutingApiError(reply, routingErrorStatus);
      return;
    }

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

function rawRequestTargetPath(requestTarget: string): string {
  const end = requestTarget.search(/[?#]/);
  const targetWithoutQuery = end === -1 ? requestTarget : requestTarget.slice(0, end);
  const absolutePrefix = /^https?:\/\//i.exec(targetWithoutQuery)?.[0];
  if (!absolutePrefix) return targetWithoutQuery;

  const pathStart = targetWithoutQuery.indexOf("/", absolutePrefix.length);
  return pathStart === -1 ? "/" : targetWithoutQuery.slice(pathStart);
}

function registeredApiParamRoutingErrorStatus(
  method: string | undefined,
  rawPath: string
): PreRoutingApiErrorStatus | undefined {
  if (method !== "GET" && method !== "POST" && method !== "DELETE") return undefined;

  const [leading, rawApi, rawDrafts, rawParameter, rawSuffix, ...extraSegments] =
    rawPath.split("/");
  if (
    leading !== "" ||
    rawApi === undefined ||
    rawDrafts === undefined ||
    rawParameter === undefined ||
    decodeURI(rawApi) !== "api" ||
    decodeURI(rawDrafts) !== "drafts" ||
    decodeURIComponent(rawParameter).length <= FASTIFY_DEFAULT_MAX_PARAM_LENGTH
  ) {
    return undefined;
  }

  if (method === "POST") {
    const exactRegisteredRoute =
      rawSuffix !== undefined &&
      extraSegments.length === 0 &&
      REGISTERED_DRAFT_POST_SUFFIXES.has(decodeURI(rawSuffix));
    return exactRegisteredRoute ? 414 : 404;
  }

  // GET and DELETE both register the bare `/api/drafts/:draftId` shape and
  // nothing under it, so an overlong parameter there is a too-long target and
  // anything deeper is a route that never existed.
  return rawSuffix === undefined ? 414 : 404;
}

function rewriteProtectedApiRoutingFailure(request: IncomingMessage): string {
  const requestTarget = request.url ?? "/";
  const rawPath = rawRequestTargetPath(requestTarget);
  const pathname = canonicalRequestTargetPath(requestTarget);
  const routeErrorStatus =
    pathname === null
      ? undefined
      : registeredApiParamRoutingErrorStatus(request.method, rawPath);
  let errorStatus: PreRoutingApiErrorStatus | undefined;

  if (pathname === null) {
    if (!hasLexicalProtectedApiPrefix(requestTarget)) return requestTarget;
    errorStatus = 400;
  } else if (isApiPolicyPath(pathname) && routeErrorStatus) {
    errorStatus = routeErrorStatus;
  }

  if (!errorStatus) return requestTarget;
  (request as MarkedIncomingMessage)[preRoutingApiErrorStatus] = errorStatus;
  return PRE_ROUTING_API_ERROR_TARGET;
}

function hasLexicalProtectedApiPrefix(requestTarget: string): boolean {
  const rawPath = rawRequestTargetPath(requestTarget);
  const asciiDecodedPath = rawPath.replace(/%([0-7][0-9a-f])/gi, (_escape, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  );
  return isApiPolicyPath(normalizePolicyPath(asciiDecodedPath));
}

function isApiPolicyPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function canonicalRequestTargetPath(requestTarget: string): string | null {
  const rawPath = rawRequestTargetPath(requestTarget);
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
    return {
      protected: true,
      requiredScope: "upload",
      uploadLimit: true
    };
  }
  // The one API route that admits a request with no credential at all. It is
  // how a caller gets its first token, so requiring one would be circular; the
  // mint's own guardrails — the enabled flag, the per-address rate limit, and
  // the per-address daily quota — are what stand in for authentication here.
  if (pathname === SELF_SERVICE_MINT_PATH) {
    return { protected: false };
  }
  if (pathname === "/api/tokens") {
    return { protected: true, requiredScope: "admin" };
  }
  return {
    protected: isApiPolicyPath(pathname)
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

function sendPreRoutingApiError(
  reply: FastifyReply,
  status: PreRoutingApiErrorStatus
): void {
  const error =
    status === 400
      ? "Malformed request target."
      : status === 404
        ? "Not found."
        : "Request target is too long.";
  reply.status(status).send({ ok: false, error });
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

// "Draft quota", not "draft limit": the glossary reserves limit-shaped wording
// for the per-minute create limit, which is a different rejection.
function sendLiveDraftQuotaExceeded(reply: FastifyReply, quota: number): FastifyReply {
  return reply.status(403).send({
    ok: false,
    error: `Draft quota reached: ${quota} live drafts per token. Delete or let a draft expire before creating another.`,
    code: "live_draft_quota_exceeded",
    quota
  });
}

/**
 * A draft as the moderation surface reports it. Spelled out field by field on
 * purpose: the record grows over time, and an operator response is not the
 * place for whatever a future column happens to hold.
 *
 * "Principal" rather than "account" — the moderation loop is operator-facing,
 * and the glossary's word for the ownership row is what it should hear.
 */
function moderationDraftView(draft: ModeratedDraftRecord): Record<string, unknown> {
  return {
    id: draft.id,
    principalId: draft.accountId,
    createdByApiTokenId: draft.createdByApiTokenId,
    title: draft.title,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    expiresAt: draft.expiresAt,
    // A pinned draft is exempt from expiry, so an operator deciding whether to
    // let a page age out needs to know the clock is not going to take it.
    pinnedAt: draft.pinnedAt,
    deletedAt: draft.deletedAt,
    disabledAt: draft.disabledAt,
    disabledReason: draft.disabledReason
  };
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

  const bearerScheme = "bearer";
  if (authHeader.length <= bearerScheme.length) return { kind: "invalid" };
  for (let index = 0; index < bearerScheme.length; index += 1) {
    if ((authHeader.charCodeAt(index) | 32) !== bearerScheme.charCodeAt(index)) {
      return { kind: "invalid" };
    }
  }

  let cursor = bearerScheme.length;
  if (!isAuthorizationWhitespace(authHeader.charCodeAt(cursor))) {
    return { kind: "invalid" };
  }
  while (
    cursor < authHeader.length &&
    isAuthorizationWhitespace(authHeader.charCodeAt(cursor))
  ) {
    cursor += 1;
  }

  const tokenStart = cursor;
  while (
    cursor < authHeader.length &&
    !isAuthorizationWhitespace(authHeader.charCodeAt(cursor))
  ) {
    cursor += 1;
  }
  if (cursor === tokenStart) return { kind: "invalid" };

  const token = authHeader.slice(tokenStart, cursor);
  while (
    cursor < authHeader.length &&
    isAuthorizationWhitespace(authHeader.charCodeAt(cursor))
  ) {
    cursor += 1;
  }
  return cursor === authHeader.length
    ? { kind: "bearer", token }
    : { kind: "invalid" };
}

function isAuthorizationWhitespace(charCode: number): boolean {
  return charCode === 0x20 || charCode === 0x09;
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
