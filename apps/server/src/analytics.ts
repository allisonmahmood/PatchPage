import { PostHog } from "posthog-node";
import type { ServerConfig } from "@patchpage/config";

/**
 * Server-side analytics — the seam every business event the instance reports
 * goes through.
 *
 * Two guarantees shape it, and both are structural rather than a matter of
 * remembering:
 *
 * **Readers stay unwatched.** Nothing here ever runs in a reader's browser: a
 * served draft carries no script source of any kind, so there is no analytics
 * JavaScript to carry. Serving a draft is deliberately not an event — a visit
 * moves a retention clock in the database and is never reported here — and no
 * event carries a source address, a reason a reader typed, page content, a
 * filename, or a URL. What ships is the shape of what happened: ids, sizes,
 * counts, and states.
 *
 * **A user's request never depends on it.** `capture` returns nothing, throws
 * nothing, and is never awaited. A failing analytics backend is a warning in
 * the log and no difference at all to the response — which is why the guard
 * lives in the base class here rather than at each of the seven call sites.
 *
 * An instance with no API key configured gets the disabled seam, which accepts
 * every event and reports none. Private instances get no analytics by default
 * and never build a client they did not ask for.
 */

/**
 * The events the instance reports. Business-shaped and named for what happened,
 * so a mint on the CLI side and a mint on the server side read as the same
 * moment in one narrative.
 *
 * The list is closed on purpose — serving a draft is not on it.
 */
export type AnalyticsEventName =
  | "token.minted"
  | "draft.created"
  | "draft.updated"
  | "draft.reported"
  | "draft.disabled"
  | "draft.deleted"
  | "draft.expired";

/** What an event property may hold. Ids, sizes, counts, and states — nothing else. */
export type AnalyticsPropertyValue = string | number | boolean | null;

export interface AnalyticsEvent {
  name: AnalyticsEventName;
  /**
   * The principal the event belongs to, or `null` for the events no principal
   * performed — an expiry sweep acts for the instance, not for anyone.
   */
  principalId: string | null;
  properties: Record<string, AnalyticsPropertyValue>;
}

export interface AnalyticsLog {
  warn(details: Record<string, unknown>, message: string): void;
}

/**
 * Who an event belongs to when no principal performed it. A constant rather
 * than a per-draft or per-address id: the alternative is inventing a person out
 * of a reader, which is exactly what the serving guarantee forbids.
 */
export const INSTANCE_DISTINCT_ID = "patchpage-instance";

/**
 * How long a capture request may take before it is abandoned. Short by design:
 * the client batches in the background, so this only bounds how long a flush
 * can sit on a socket, and nothing waits on the answer either way.
 */
const CAPTURE_REQUEST_TIMEOUT_MS = 3_000;

/** How many events collect before a batch goes out, and how long that wait may run. */
const CAPTURE_FLUSH_AT = 20;
const CAPTURE_FLUSH_INTERVAL_MS = 10_000;

/** How long a shutdown flush may take before the process stops waiting for it. */
const SHUTDOWN_FLUSH_TIMEOUT_MS = 3_000;

/**
 * The upstream client an enabled seam writes to. Narrowed to the two calls this
 * service makes, so the PostHog SDK stays behind one adapter.
 */
export interface AnalyticsClient {
  capture(message: {
    distinctId: string;
    event: string;
    properties: Record<string, unknown>;
  }): void;
  shutdown(shutdownTimeoutMs?: number): Promise<void>;
}

export interface AnalyticsClientOptions {
  apiKey: string;
  host: string;
}

export interface CreateAnalyticsOptions {
  log?: AnalyticsLog;
  /**
   * Builds the upstream client. PostHog by default; the seam exists so that
   * "an unconfigured instance never builds one" is an observable fact.
   */
  createClient?: (options: AnalyticsClientOptions) => AnalyticsClient;
}

/** The capture seam every business event goes through. */
export abstract class Analytics {
  constructor(protected readonly log?: AnalyticsLog) {}

  /**
   * Reports one event. Fire-and-forget: it never throws, never returns a
   * promise, and must never be awaited. Callers hand it what happened and
   * carry on answering the request.
   */
  capture(event: AnalyticsEvent): void {
    try {
      this.send(event);
    } catch (error) {
      this.log?.warn({ err: error, event: event.name }, "Analytics capture failed.");
    }
  }

  /** Flushes whatever is queued. Called once, on the way down. */
  async shutdown(): Promise<void> {}

  /** Where an event actually goes. */
  protected abstract send(event: AnalyticsEvent): void;
}

/**
 * The seam an instance with no key configured runs with. It accepts every
 * event and reports none — no client, no connection, no request.
 */
export class DisabledAnalytics extends Analytics {
  protected override send(): void {}
}

/**
 * Builds the seam an instance runs with: a reporting one when an API key is
 * configured, the disabled one when it is not.
 */
export function createAnalytics(
  config: ServerConfig,
  options: CreateAnalyticsOptions = {}
): Analytics {
  const apiKey = config.posthogApiKey;
  if (!apiKey) return new DisabledAnalytics(options.log);

  const createClient = options.createClient ?? createPostHogClient;
  return new ReportingAnalytics(createClient({ apiKey, host: config.posthogHost }), options.log);
}

/** The seam an instance with a key configured runs with. */
class ReportingAnalytics extends Analytics {
  constructor(
    private readonly client: AnalyticsClient,
    log?: AnalyticsLog
  ) {
    super(log);
  }

  override async shutdown(): Promise<void> {
    try {
      await this.client.shutdown(SHUTDOWN_FLUSH_TIMEOUT_MS);
    } catch (error) {
      this.log?.warn({ err: error }, "Analytics shutdown flush failed.");
    }
  }

  protected override send(event: AnalyticsEvent): void {
    this.client.capture({
      distinctId: event.principalId ?? INSTANCE_DISTINCT_ID,
      event: event.name,
      properties: {
        ...event.properties,
        // A principal is an ownership row, not a person, and a reader is
        // nobody at all. Person profiles would turn both into one.
        $process_person_profile: false
      }
    });
  }
}

function createPostHogClient(options: AnalyticsClientOptions): AnalyticsClient {
  return new PostHog(options.apiKey, {
    host: options.host,
    flushAt: CAPTURE_FLUSH_AT,
    flushInterval: CAPTURE_FLUSH_INTERVAL_MS,
    requestTimeout: CAPTURE_REQUEST_TIMEOUT_MS,
    // The server is the only caller, so the address on the wire is the
    // instance's own. Resolving it to a location would describe the datacenter
    // and nothing else.
    disableGeoip: true
  });
}
