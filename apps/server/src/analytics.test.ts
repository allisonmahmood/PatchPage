import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerConfig } from "@patchpage/config";
import { JsonFilePatchPageDb } from "@patchpage/db";
import { FileSystemHtmlStorage } from "@patchpage/storage";
import {
  Analytics,
  createAnalytics,
  INSTANCE_DISTINCT_ID,
  type AnalyticsClient,
  type AnalyticsClientOptions,
  type AnalyticsEvent
} from "./analytics.js";
import { createApp } from "./app.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MINT_PATH = "/api/tokens/self-service";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "patchpage-analytics-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/** A seam that keeps what it was handed instead of reporting it. */
class RecordingAnalytics extends Analytics {
  readonly events: AnalyticsEvent[] = [];

  protected override send(event: AnalyticsEvent): void {
    this.events.push(event);
  }

  names(): string[] {
    return this.events.map((event) => event.name);
  }

  only(): AnalyticsEvent {
    expect(this.events).toHaveLength(1);
    return this.events[0] as AnalyticsEvent;
  }
}

/** A seam whose backend is down. */
class FailingAnalytics extends Analytics {
  protected override send(): void {
    throw new Error("Forced analytics failure.");
  }
}

/** An upstream client that keeps every message rather than sending one. */
class RecordingAnalyticsClient implements AnalyticsClient {
  readonly messages: {
    distinctId: string;
    event: string;
    properties: Record<string, unknown>;
  }[] = [];
  shutdownCalls = 0;

  capture(message: {
    distinctId: string;
    event: string;
    properties: Record<string, unknown>;
  }): void {
    this.messages.push(message);
  }

  async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
  }
}

function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
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
    reportRateLimitPerMinute: 10,
    liveDraftsPerToken: 1_000,
    posthogApiKey: null,
    posthogHost: "https://us.i.posthog.com",
    dbDriver: "json",
    databaseUrl: null,
    jsonDbFile: path.join(tempDir, "db.json"),
    storageDriver: "filesystem",
    storageDir: path.join(tempDir, "drafts"),
    azureStorageAccount: null,
    azureStorageContainer: null,
    azureStorageConnectionString: null,
    ...overrides
  };
}

interface WatchedApp {
  readonly app: ReturnType<typeof createApp>;
  readonly analytics: RecordingAnalytics;
  advanceDays(days: number): void;
  createDraft(title: string, token?: string): Promise<string>;
  close(): Promise<void>;
}

/**
 * An app wired to a recording seam, with the clock its database also reads, so
 * a test can wind the retention clock forward and sweep.
 */
async function createWatchedApp(
  label: string,
  options: { analytics?: Analytics; config?: Partial<ServerConfig> } = {}
): Promise<WatchedApp> {
  let now = Date.UTC(2026, 0, 1);
  const clock = (): number => now;
  const analytics = options.analytics ?? new RecordingAnalytics();
  const db = new JsonFilePatchPageDb(path.join(tempDir, `${label}-db.json`), { clock });
  await db.initialize("dev-token");
  const storage = new FileSystemHtmlStorage(path.join(tempDir, `${label}-drafts`));
  const config = testConfig({
    jsonDbFile: path.join(tempDir, `${label}-db.json`),
    ...options.config
  });
  const app = createApp({ config, db, storage, clock, analytics });

  return {
    app,
    // Only the recording seam exposes what it kept; a test that passes its own
    // seam reads that one instead.
    analytics: analytics as RecordingAnalytics,
    advanceDays(days) {
      now += days * DAY_MS;
    },
    async createDraft(title, token = "dev-token") {
      const upload = await app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          html: `<!doctype html><html><head><title>${title}</title></head><body><p>x</p></body></html>`
        }
      });
      expect(upload.statusCode).toBe(201);
      return (upload.json() as { draftId: string }).draftId;
    },
    async close() {
      await app.close();
      await db.close();
    }
  };
}

describe("server-side analytics", () => {
  it("reports a self-service mint as one event on the principal it created", async () => {
    const watched = await createWatchedApp("mint", {
      config: { allowSelfServiceTokens: true }
    });

    const mint = await watched.app.inject({
      method: "POST",
      url: MINT_PATH,
      headers: { "content-type": "application/json" },
      payload: "{}",
      remoteAddress: "203.0.113.9"
    });
    expect(mint.statusCode).toBe(201);
    const minted = (mint.json() as { token: string }).token;

    const me = await watched.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${minted}` }
    });
    const principal = me.json() as { accountId: string; apiTokenId: string };

    expect(watched.analytics.only()).toEqual({
      name: "token.minted",
      principalId: principal.accountId,
      properties: { apiTokenId: principal.apiTokenId, selfService: true }
    });

    await watched.close();
  });

  it("reports an operator-issued token as a mint that was not self-service", async () => {
    const watched = await createWatchedApp("admin-mint");

    const created = await watched.app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: { authorization: "Bearer dev-token" },
      payload: { name: "Teammate", scopes: ["upload"] }
    });
    expect(created.statusCode).toBe(201);
    const apiToken = (created.json() as { apiToken: { id: string } }).apiToken;

    const event = watched.analytics.only();
    expect(event.name).toBe("token.minted");
    expect(event.properties).toEqual({ apiTokenId: apiToken.id, selfService: false });
    // The plaintext exists in that response and must never leave through here.
    expect(JSON.stringify(event)).not.toContain("pp_");
    // Nor the name an operator chose for it.
    expect(JSON.stringify(event)).not.toContain("Teammate");

    await watched.close();
  });

  it("reports nothing when a mint is refused", async () => {
    const watched = await createWatchedApp("mint-refused");

    const mint = await watched.app.inject({
      method: "POST",
      url: MINT_PATH,
      headers: { "content-type": "application/json" },
      payload: "{}"
    });
    expect(mint.statusCode).toBe(403);
    expect(watched.analytics.events).toEqual([]);

    await watched.close();
  });

  it("reports a created draft and then an updated one, with its size and version", async () => {
    const watched = await createWatchedApp("upload");

    const draftId = await watched.createDraft("First");
    const update = await watched.app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { authorization: "Bearer dev-token" },
      payload: {
        draftId,
        html: "<!doctype html><html><head><title>Second</title></head><body></body></html>"
      }
    });
    expect(update.statusCode).toBe(200);

    expect(watched.analytics.names()).toEqual(["draft.created", "draft.updated"]);
    const [created, updated] = watched.analytics.events as [AnalyticsEvent, AnalyticsEvent];
    expect(created.properties.draftId).toBe(draftId);
    expect(created.properties.versionNumber).toBe(1);
    expect(created.properties.htmlBytes).toBeGreaterThan(0);
    expect(typeof created.properties.apiTokenId).toBe("string");
    expect(created.principalId).toBe(updated.principalId);
    expect(updated.properties.draftId).toBe(draftId);
    expect(updated.properties.versionNumber).toBe(2);

    await watched.close();
  });

  it("reports nothing when an upload is refused", async () => {
    const watched = await createWatchedApp("upload-refused");

    const invalid = await watched.app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { authorization: "Bearer dev-token" },
      payload: { html: "<script>alert(1)</script>" }
    });
    expect(invalid.statusCode).toBe(422);
    expect(watched.analytics.events).toEqual([]);

    await watched.close();
  });

  it("reports a report against the reported draft's principal, never the reader", async () => {
    const watched = await createWatchedApp("report");
    const draftId = await watched.createDraft("Reported");
    watched.analytics.events.length = 0;

    const report = await watched.app.inject({
      method: "POST",
      url: `/report/${draftId}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "reason=this+page+is+a+phishing+lure",
      remoteAddress: "198.51.100.7"
    });
    expect(report.statusCode).toBe(200);

    const event = watched.analytics.only();
    expect(event.name).toBe("draft.reported");
    expect(event.properties).toEqual({ draftId, reasonGiven: true });
    // The reader is nobody: no address anywhere, and the sentence they typed
    // stays in the database rather than going out as a property.
    expect(JSON.stringify(event)).not.toContain("198.51.100.7");
    expect(JSON.stringify(event)).not.toContain("phishing");

    await watched.close();
  });

  it("reports whether a report carried a reason without carrying the reason", async () => {
    const watched = await createWatchedApp("report-bare");
    const draftId = await watched.createDraft("Reported");
    watched.analytics.events.length = 0;

    const report = await watched.app.inject({
      method: "POST",
      url: `/report/${draftId}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: ""
    });
    expect(report.statusCode).toBe(200);
    expect(watched.analytics.only().properties).toEqual({ draftId, reasonGiven: false });

    await watched.close();
  });

  it("reports a disabled draft and a deleted one, marking who acted", async () => {
    const watched = await createWatchedApp("moderation");
    const disabledId = await watched.createDraft("To disable");
    const deletedId = await watched.createDraft("To delete");
    watched.analytics.events.length = 0;

    const disable = await watched.app.inject({
      method: "POST",
      url: `/api/drafts/${disabledId}/disable`,
      headers: { authorization: "Bearer dev-token" },
      payload: { reason: "Reported and reviewed." }
    });
    expect(disable.statusCode).toBe(200);

    const remove = await watched.app.inject({
      method: "DELETE",
      url: `/api/drafts/${deletedId}`,
      headers: { authorization: "Bearer dev-token" }
    });
    expect(remove.statusCode).toBe(200);

    expect(watched.analytics.names()).toEqual(["draft.disabled", "draft.deleted"]);
    const [disabled, deleted] = watched.analytics.events as [AnalyticsEvent, AnalyticsEvent];
    expect(disabled.properties).toEqual({ draftId: disabledId, admin: true });
    expect(deleted.properties).toEqual({ draftId: deletedId, admin: true });
    // The reason an operator typed is moderation state, not an event property.
    expect(JSON.stringify(watched.analytics.events)).not.toContain("Reported and reviewed.");

    await watched.close();
  });

  it("marks a draft its own owner disabled or deleted as not an operator's act", async () => {
    const watched = await createWatchedApp("moderation-owner", {
      config: { allowSelfServiceTokens: true }
    });

    const mint = await watched.app.inject({
      method: "POST",
      url: MINT_PATH,
      headers: { "content-type": "application/json" },
      payload: "{}",
      remoteAddress: "203.0.113.14"
    });
    expect(mint.statusCode).toBe(201);
    const owner = (mint.json() as { token: string }).token;

    const disabledId = await watched.createDraft("Mine to disable", owner);
    const deletedId = await watched.createDraft("Mine to delete", owner);
    watched.analytics.events.length = 0;

    const disable = await watched.app.inject({
      method: "POST",
      url: `/api/drafts/${disabledId}/disable`,
      headers: { authorization: `Bearer ${owner}` }
    });
    expect(disable.statusCode).toBe(200);

    const remove = await watched.app.inject({
      method: "DELETE",
      url: `/api/drafts/${deletedId}`,
      headers: { authorization: `Bearer ${owner}` }
    });
    expect(remove.statusCode).toBe(200);

    expect(watched.analytics.names()).toEqual(["draft.disabled", "draft.deleted"]);
    const [disabled, deleted] = watched.analytics.events as [AnalyticsEvent, AnalyticsEvent];
    expect(disabled.properties).toEqual({ draftId: disabledId, admin: false });
    expect(deleted.properties).toEqual({ draftId: deletedId, admin: false });

    await watched.close();
  });

  it("reports nothing when a moderation request finds no draft", async () => {
    const watched = await createWatchedApp("moderation-missing");

    const disable = await watched.app.inject({
      method: "POST",
      url: "/api/drafts/drf_00000000000000000000000000/disable",
      headers: { authorization: "Bearer dev-token" }
    });
    expect(disable.statusCode).toBe(404);

    const remove = await watched.app.inject({
      method: "DELETE",
      url: "/api/drafts/drf_00000000000000000000000000",
      headers: { authorization: "Bearer dev-token" }
    });
    expect(remove.statusCode).toBe(404);
    expect(watched.analytics.events).toEqual([]);

    await watched.close();
  });

  it("reports an expired draft when the sweep takes it, on no principal at all", async () => {
    const watched = await createWatchedApp("expiry");
    const draftId = await watched.createDraft("Ages out");
    watched.analytics.events.length = 0;

    watched.advanceDays(91);
    const result = await watched.app.sweepExpiredDrafts();
    expect(result.deleted).toBe(1);

    expect(watched.analytics.only()).toEqual({
      name: "draft.expired",
      principalId: null,
      properties: { draftId, versionsRemoved: 1 }
    });

    await watched.close();
  });

  it("reports nothing when a sweep takes nothing", async () => {
    const watched = await createWatchedApp("expiry-empty");
    await watched.createDraft("Still fresh");
    watched.analytics.events.length = 0;

    const result = await watched.app.sweepExpiredDrafts();
    expect(result.deleted).toBe(0);
    expect(watched.analytics.events).toEqual([]);

    await watched.close();
  });

  it("reports nothing when a draft is served, at either URL", async () => {
    const watched = await createWatchedApp("serving");
    const draftId = await watched.createDraft("Read me");
    watched.analytics.events.length = 0;

    const latest = await watched.app.inject({ method: "GET", url: `/d/${draftId}` });
    expect(latest.statusCode).toBe(200);
    const version = await watched.app.inject({ method: "GET", url: `/d/${draftId}/v/1` });
    expect(version.statusCode).toBe(200);
    const reportForm = await watched.app.inject({ method: "GET", url: `/report/${draftId}` });
    expect(reportForm.statusCode).toBe(200);

    // Readers are unwatched: a visit moves a retention clock and is reported
    // nowhere, and nothing analytics-shaped reaches the page either.
    expect(watched.analytics.events).toEqual([]);
    for (const response of [latest, version, reportForm]) {
      expect(response.body).not.toContain("posthog");
      expect(response.body).not.toContain("<script");
      // No cookie, and a policy that admits no script source at all: scripts
      // fall to `default-src 'none'` and no directive re-opens them. There is
      // nowhere for analytics JavaScript to arrive from even if something one
      // day tried to put it on the page.
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
      expect(response.headers["content-security-policy"]).not.toContain("script-src");
    }

    await watched.close();
  });

  it("reports nothing for the routes that are not on the list", async () => {
    const watched = await createWatchedApp("closed-list");
    const draftId = await watched.createDraft("Pinned");
    watched.analytics.events.length = 0;

    for (const suffix of ["pin", "unpin"]) {
      const response = await watched.app.inject({
        method: "POST",
        url: `/api/drafts/${draftId}/${suffix}`,
        headers: { authorization: "Bearer dev-token" }
      });
      expect(response.statusCode).toBe(200);
    }

    const me = await watched.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: "Bearer dev-token" }
    });
    expect(me.statusCode).toBe(200);

    // The seven are the whole list. Pinning, unpinning, and reading are things
    // that happen; they are not moments the instance reports.
    expect(watched.analytics.events).toEqual([]);

    await watched.close();
  });

  it("answers every request normally when capture fails", async () => {
    const watched = await createWatchedApp("failing", {
      analytics: new FailingAnalytics(),
      config: { allowSelfServiceTokens: true }
    });

    const mint = await watched.app.inject({
      method: "POST",
      url: MINT_PATH,
      headers: { "content-type": "application/json" },
      payload: "{}",
      remoteAddress: "203.0.113.11"
    });
    expect(mint.statusCode).toBe(201);
    expect((mint.json() as { token: string }).token).toMatch(/^pp_/);

    const draftId = await watched.createDraft("Survives");

    const update = await watched.app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { authorization: "Bearer dev-token" },
      payload: {
        draftId,
        html: "<!doctype html><html><head><title>Again</title></head><body></body></html>"
      }
    });
    expect(update.statusCode).toBe(200);

    const report = await watched.app.inject({
      method: "POST",
      url: `/report/${draftId}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "reason=spam"
    });
    expect(report.statusCode).toBe(200);

    const disable = await watched.app.inject({
      method: "POST",
      url: `/api/drafts/${draftId}/disable`,
      headers: { authorization: "Bearer dev-token" }
    });
    expect(disable.statusCode).toBe(200);

    const remove = await watched.app.inject({
      method: "DELETE",
      url: `/api/drafts/${draftId}`,
      headers: { authorization: "Bearer dev-token" }
    });
    expect(remove.statusCode).toBe(200);

    await watched.close();
  });

  it("finishes the expiry sweep when capture fails", async () => {
    const watched = await createWatchedApp("failing-sweep", {
      analytics: new FailingAnalytics()
    });
    await watched.createDraft("Ages out");

    watched.advanceDays(91);
    const result = await watched.app.sweepExpiredDrafts();

    expect(result).toEqual({ deleted: 1, skipped: 0, failed: 0, orphanedObjects: 0 });

    await watched.close();
  });
});

describe("analytics configuration", () => {
  it("builds no client and reports nothing when no key is configured", async () => {
    const clients: RecordingAnalyticsClient[] = [];
    const analytics = createAnalytics(testConfig(), {
      createClient: () => {
        const client = new RecordingAnalyticsClient();
        clients.push(client);
        return client;
      }
    });

    const watched = await createWatchedApp("unconfigured", { analytics });
    const draftId = await watched.createDraft("Private instance");
    const remove = await watched.app.inject({
      method: "DELETE",
      url: `/api/drafts/${draftId}`,
      headers: { authorization: "Bearer dev-token" }
    });
    expect(remove.statusCode).toBe(200);
    await watched.close();

    expect(clients).toEqual([]);

    // Shutting a seam that never reported down is still a no-op, not a crash.
    await analytics.shutdown();
  });

  it("reports through the configured client when a key is set", async () => {
    const client = new RecordingAnalyticsClient();
    const built: AnalyticsClientOptions[] = [];
    const analytics = createAnalytics(
      testConfig({ posthogApiKey: "phc_test", posthogHost: "https://eu.i.posthog.com" }),
      {
        createClient: (options) => {
          built.push(options);
          return client;
        }
      }
    );

    expect(built).toEqual([{ apiKey: "phc_test", host: "https://eu.i.posthog.com" }]);

    const watched = await createWatchedApp("configured", { analytics });
    const draftId = await watched.createDraft("Reported upstream");
    await watched.close();

    expect(client.messages).toHaveLength(1);
    const message = client.messages[0] as (typeof client.messages)[number];
    expect(message.event).toBe("draft.created");
    expect(message.distinctId).toMatch(/^acct_/);
    expect(message.properties.draftId).toBe(draftId);
    // A principal is an ownership row, not a person.
    expect(message.properties.$process_person_profile).toBe(false);

    await analytics.shutdown();
    expect(client.shutdownCalls).toBe(1);
  });

  it("reports events no principal performed under the instance", async () => {
    const client = new RecordingAnalyticsClient();
    const analytics = createAnalytics(testConfig({ posthogApiKey: "phc_test" }), {
      createClient: () => client
    });

    const watched = await createWatchedApp("instance", { analytics });
    await watched.createDraft("Ages out");
    watched.advanceDays(91);
    await watched.app.sweepExpiredDrafts();
    await watched.close();

    const expired = client.messages.find((message) => message.event === "draft.expired");
    expect(expired?.distinctId).toBe(INSTANCE_DISTINCT_ID);
  });

  it("keeps a failing client's error away from the caller", async () => {
    class BrokenClient extends RecordingAnalyticsClient {
      override capture(): void {
        throw new Error("Forced client failure.");
      }
      override async shutdown(): Promise<void> {
        throw new Error("Forced shutdown failure.");
      }
    }

    const analytics = createAnalytics(testConfig({ posthogApiKey: "phc_test" }), {
      createClient: () => new BrokenClient()
    });

    const watched = await createWatchedApp("broken-client", { analytics });
    const draftId = await watched.createDraft("Still published");
    expect(draftId.length).toBeGreaterThan(0);
    await watched.close();

    await expect(analytics.shutdown()).resolves.toBeUndefined();
  });
});
