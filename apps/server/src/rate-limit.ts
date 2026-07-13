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
}

export interface RateLimitConfig {
  protectedApiRateLimitPerMinute: number;
  authenticatedUploadRateLimitPerMinute: number;
  anonymousCreateRateLimitPerMinute: number;
}

export interface RateLimiters {
  protectedApi: FixedWindowRateLimiter;
  authenticatedUpload: FixedWindowRateLimiter;
  anonymousCreate: FixedWindowRateLimiter;
}

export interface CreateRateLimitersOptions {
  clock?: () => number;
  maxKeys?: number;
}

interface Bucket {
  count: number;
  resetAt: number;
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
    anonymousCreate: new FixedWindowRateLimiter({
      ...base,
      limit: config.anonymousCreateRateLimitPerMinute
    })
  };
}

export class FixedWindowRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly clock: () => number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(options: FixedWindowRateLimiterOptions) {
    this.limit = boundedInteger("limit", options.limit, MAX_ATTEMPTS_PER_WINDOW);
    this.windowMs = boundedInteger("windowMs", options.windowMs, MAX_WINDOW_MS);
    this.maxKeys = boundedInteger("maxKeys", options.maxKeys, MAX_STORED_KEYS);
    this.clock = options.clock ?? Date.now;
  }

  consume(key: string): RateLimitDecision {
    const now = this.clock();
    this.pruneExpired(now);
    const bucket = this.buckets.get(key);

    if (!bucket || now >= bucket.resetAt) {
      if (!bucket && this.buckets.size >= this.maxKeys) {
        const resetAt = this.earliestResetAt() ?? now + this.windowMs;
        return {
          allowed: false,
          remaining: 0,
          resetAt,
          retryAfterSeconds: retryAfterSeconds(now, resetAt)
        };
      }

      const resetAt = now + this.windowMs;
      this.buckets.set(key, { count: 1, resetAt });
      return { allowed: true, remaining: this.limit - 1, resetAt };
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

  private pruneExpired(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now >= bucket.resetAt) {
        this.buckets.delete(key);
      }
    }
  }

  private earliestResetAt(): number | null {
    let resetAt: number | null = null;
    for (const bucket of this.buckets.values()) {
      resetAt = resetAt === null ? bucket.resetAt : Math.min(resetAt, bucket.resetAt);
    }
    return resetAt;
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
