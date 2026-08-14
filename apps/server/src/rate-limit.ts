export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfterSeconds?: number;
}

export interface FixedWindowRateLimiterOptions {
  limit: number;
  windowMs: number;
  maxKeys: number;
  clock?: () => number;
  diagnostics?: FixedWindowRateLimiterDiagnostics;
}

export interface FixedWindowRateLimiterDiagnostics {
  onExpirationInspection?: (key: string) => void;
  onExpirationRemoval?: (key: string) => void;
}

export interface RateLimitConfig {
  protectedApiRateLimitPerMinute: number;
  authenticatedUploadRateLimitPerMinute: number;
  selfServiceMintRateLimitPerMinute: number;
  draftCreateRateLimitPerMinute: number;
}

export interface RateLimiters {
  protectedApi: FixedWindowRateLimiter;
  authenticatedUpload: FixedWindowRateLimiter;
  /**
   * Self-service mints per minute, keyed by source address — the only limiter
   * on an unauthenticated route, since a caller asking for its first token has
   * no token to key on yet. This is the fast half of the mint guardrail; the
   * per-day ceiling is a database count, so a restart empties this bucket but
   * not that one.
   */
  selfServiceMint: FixedWindowRateLimiter;
  /**
   * Draft creates per minute, keyed by the creating token. Only per-minute
   * limits live in memory; the long-window live-draft quota is a database
   * count, so a restart resets this bucket but not that ceiling.
   */
  draftCreate: FixedWindowRateLimiter;
}

export interface CreateRateLimitersOptions {
  clock?: () => number;
  maxKeys?: number;
}

interface Bucket {
  count: number;
  resetAt: number;
  previousExpiringKey: string | null;
  nextExpiringKey: string | null;
}

const ONE_MINUTE_MS = 60_000;
const DEFAULT_MAX_KEYS = 10_000;
const MAX_ATTEMPTS_PER_WINDOW = 10_000;
const MAX_WINDOW_MS = 86_400_000;
const MAX_STORED_KEYS = 10_000;

export function createRateLimiters(
  config: RateLimitConfig,
  options: CreateRateLimitersOptions = {}
): RateLimiters {
  const base = {
    windowMs: ONE_MINUTE_MS,
    maxKeys: options.maxKeys ?? DEFAULT_MAX_KEYS,
    clock: options.clock
  };

  return {
    protectedApi: new FixedWindowRateLimiter({
      ...base,
      limit: config.protectedApiRateLimitPerMinute
    }),
    authenticatedUpload: new FixedWindowRateLimiter({
      ...base,
      limit: config.authenticatedUploadRateLimitPerMinute
    }),
    selfServiceMint: new FixedWindowRateLimiter({
      ...base,
      limit: config.selfServiceMintRateLimitPerMinute
    }),
    draftCreate: new FixedWindowRateLimiter({
      ...base,
      limit: config.draftCreateRateLimitPerMinute
    })
  };
}

export class FixedWindowRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly clock: () => number;
  private readonly diagnostics: FixedWindowRateLimiterDiagnostics | undefined;
  private readonly buckets = new Map<string, Bucket>();
  private expirationHead: string | null = null;
  private expirationTail: string | null = null;
  private nextExpirationAt: number | null = null;
  private lastNow = 0;

  constructor(options: FixedWindowRateLimiterOptions) {
    this.limit = boundedInteger("limit", options.limit, MAX_ATTEMPTS_PER_WINDOW);
    this.windowMs = boundedInteger("windowMs", options.windowMs, MAX_WINDOW_MS);
    this.maxKeys = boundedInteger("maxKeys", options.maxKeys, MAX_STORED_KEYS);
    this.clock = options.clock ?? Date.now;
    this.diagnostics = options.diagnostics;
  }

  consume(key: string): RateLimitDecision {
    const now = this.now();
    this.pruneExpired(now);
    const bucket = this.buckets.get(key);

    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) {
        const resetAt = this.nextExpirationAt ?? now + this.windowMs;
        return {
          allowed: false,
          remaining: 0,
          resetAt,
          retryAfterSeconds: retryAfterSeconds(now, resetAt)
        };
      }

      return this.createBucket(key, now);
    }

    if (bucket.count >= this.limit) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: bucket.resetAt,
        retryAfterSeconds: retryAfterSeconds(now, bucket.resetAt)
      };
    }

    bucket.count += 1;
    return {
      allowed: true,
      remaining: this.limit - bucket.count,
      resetAt: bucket.resetAt
    };
  }

  private now(): number {
    const current = this.clock();
    this.lastNow = Math.max(this.lastNow, current);
    return this.lastNow;
  }

  private createBucket(key: string, now: number): RateLimitDecision {
    const resetAt = now + this.windowMs;
    const bucket: Bucket = {
      count: 1,
      resetAt,
      previousExpiringKey: this.expirationTail,
      nextExpiringKey: null
    };

    if (this.expirationTail) {
      const tail = this.buckets.get(this.expirationTail);
      if (tail) tail.nextExpiringKey = key;
    } else {
      this.expirationHead = key;
      this.nextExpirationAt = resetAt;
    }

    this.expirationTail = key;
    this.buckets.set(key, bucket);
    return { allowed: true, remaining: this.limit - 1, resetAt };
  }

  private pruneExpired(now: number): void {
    if (this.nextExpirationAt === null || now < this.nextExpirationAt) return;

    while (this.expirationHead && this.nextExpirationAt !== null && now >= this.nextExpirationAt) {
      const key = this.expirationHead;
      const bucket = this.buckets.get(key);
      if (!bucket) {
        this.expirationHead = null;
        this.expirationTail = null;
        this.nextExpirationAt = null;
        return;
      }

      this.diagnostics?.onExpirationInspection?.(key);
      this.removeBucket(key, bucket);
      this.diagnostics?.onExpirationRemoval?.(key);
    }
  }

  private removeBucket(key: string, bucket: Bucket): void {
    const previous = bucket.previousExpiringKey;
    const next = bucket.nextExpiringKey;

    if (previous) {
      const previousBucket = this.buckets.get(previous);
      if (previousBucket) previousBucket.nextExpiringKey = next;
    } else {
      this.expirationHead = next;
    }

    if (next) {
      const nextBucket = this.buckets.get(next);
      if (nextBucket) nextBucket.previousExpiringKey = previous;
    } else {
      this.expirationTail = previous;
    }

    this.buckets.delete(key);
    this.nextExpirationAt = this.expirationHead
      ? this.buckets.get(this.expirationHead)?.resetAt ?? null
      : null;
  }
}

function retryAfterSeconds(now: number, resetAt: number): number {
  return Math.max(1, Math.ceil((resetAt - now) / 1_000));
}

function boundedInteger(name: string, value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer from 1 through ${max}.`);
  }
  return value;
}
