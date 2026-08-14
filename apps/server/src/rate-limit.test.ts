import { describe, expect, it } from "vitest";
import { FixedWindowRateLimiter, createRateLimiters } from "./rate-limit.js";

describe("FixedWindowRateLimiter", () => {
  it("blocks over-limit attempts until the exact reset boundary", () => {
    let now = 1_000;
    const limiter = new FixedWindowRateLimiter({
      limit: 2,
      windowMs: 1_000,
      maxKeys: 10,
      clock: () => now
    });

    expect(limiter.consume("client")).toMatchObject({
      allowed: true,
      remaining: 1,
      resetAt: 2_000
    });
    expect(limiter.consume("client")).toMatchObject({
      allowed: true,
      remaining: 0,
      resetAt: 2_000
    });

    const blocked = limiter.consume("client");
    expect(blocked).toMatchObject({
      allowed: false,
      retryAfterSeconds: 1,
      resetAt: 2_000
    });
    expect(Number.isInteger(blocked.retryAfterSeconds)).toBe(true);

    now = 1_999;
    expect(limiter.consume("client")).toMatchObject({
      allowed: false,
      retryAfterSeconds: 1,
      resetAt: 2_000
    });

    now = 2_000;
    expect(limiter.consume("client")).toMatchObject({
      allowed: true,
      remaining: 1,
      resetAt: 3_000
    });
  });

  it("bounds active keys and prunes expired buckets before admitting new keys", () => {
    let now = 1_000;
    const limiter = new FixedWindowRateLimiter({
      limit: 1,
      windowMs: 1_000,
      maxKeys: 2,
      clock: () => now
    });

    expect(limiter.consume("client-a")).toMatchObject({ allowed: true, resetAt: 2_000 });
    expect(limiter.consume("client-b")).toMatchObject({ allowed: true, resetAt: 2_000 });
    expect(limiter.consume("client-c")).toMatchObject({
      allowed: false,
      retryAfterSeconds: 1,
      resetAt: 2_000
    });

    now = 2_000;
    expect(limiter.consume("client-c")).toMatchObject({
      allowed: true,
      remaining: 0,
      resetAt: 3_000
    });
  });

  it("does not scan live buckets on active or capacity-blocked consumes", () => {
    let now = 1_000;
    const inspected: string[] = [];
    const removed: string[] = [];
    const limiter = new FixedWindowRateLimiter({
      limit: 1,
      windowMs: 1_000,
      maxKeys: 3,
      clock: () => now,
      diagnostics: {
        onExpirationInspection: (key) => inspected.push(key),
        onExpirationRemoval: (key) => removed.push(key)
      }
    });

    expect(limiter.consume("client-a")).toMatchObject({ allowed: true, resetAt: 2_000 });
    expect(limiter.consume("client-b")).toMatchObject({ allowed: true, resetAt: 2_000 });
    expect(limiter.consume("client-c")).toMatchObject({ allowed: true, resetAt: 2_000 });
    inspected.length = 0;
    removed.length = 0;

    expect(limiter.consume("client-a")).toMatchObject({
      allowed: false,
      resetAt: 2_000
    });
    expect(limiter.consume("client-d")).toMatchObject({
      allowed: false,
      resetAt: 2_000
    });
    expect(inspected).toEqual([]);
    expect(removed).toEqual([]);

    now = 2_000;
    expect(limiter.consume("client-a")).toMatchObject({
      allowed: true,
      resetAt: 3_000
    });
    expect(inspected).toEqual(["client-a", "client-b", "client-c"]);
    expect(removed).toEqual(["client-a", "client-b", "client-c"]);

    inspected.length = 0;
    removed.length = 0;
    now = 2_500;
    expect(limiter.consume("client-a")).toMatchObject({
      allowed: false,
      resetAt: 3_000
    });
    expect(inspected).toEqual([]);
    expect(removed).toEqual([]);
  });

  it("exposes a real authenticated-upload limiter at twenty attempts per token", () => {
    let now = 1_000;
    const limiters = createRateLimiters(
      {
        protectedApiRateLimitPerMinute: 60,
        authenticatedUploadRateLimitPerMinute: 20,
        selfServiceMintRateLimitPerMinute: 5,
        draftCreateRateLimitPerMinute: 10
      },
      {
        clock: () => now,
        maxKeys: 10
      }
    );

    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(limiters.authenticatedUpload.consume("tok_example")).toMatchObject({
        allowed: true,
        resetAt: 61_000
      });
    }

    expect(limiters.authenticatedUpload.consume("tok_example")).toMatchObject({
      allowed: false,
      retryAfterSeconds: 60,
      resetAt: 61_000
    });

    now = 61_000;
    expect(limiters.authenticatedUpload.consume("tok_example")).toMatchObject({
      allowed: true,
      resetAt: 121_000
    });
  });

  it("exposes a real draft-create limiter at ten attempts per token", () => {
    let now = 1_000;
    const limiters = createRateLimiters(
      {
        protectedApiRateLimitPerMinute: 60,
        authenticatedUploadRateLimitPerMinute: 20,
        selfServiceMintRateLimitPerMinute: 5,
        draftCreateRateLimitPerMinute: 10
      },
      {
        clock: () => now,
        maxKeys: 10
      }
    );

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(limiters.draftCreate.consume("tok_one")).toMatchObject({
        allowed: true,
        resetAt: 61_000
      });
    }

    expect(limiters.draftCreate.consume("tok_one")).toMatchObject({
      allowed: false,
      retryAfterSeconds: 60,
      resetAt: 61_000
    });
    // A second token has its own bucket, and the upload bucket is untouched.
    expect(limiters.draftCreate.consume("tok_two")).toMatchObject({ allowed: true });
    expect(limiters.authenticatedUpload.consume("tok_one")).toMatchObject({
      allowed: true,
      remaining: 19
    });

    now = 61_000;
    expect(limiters.draftCreate.consume("tok_one")).toMatchObject({
      allowed: true,
      resetAt: 121_000
    });
  });

  it("exposes a real self-service mint limiter keyed by source address", () => {
    let now = 1_000;
    const limiters = createRateLimiters(
      {
        protectedApiRateLimitPerMinute: 60,
        authenticatedUploadRateLimitPerMinute: 20,
        selfServiceMintRateLimitPerMinute: 3,
        draftCreateRateLimitPerMinute: 10
      },
      {
        clock: () => now,
        maxKeys: 10
      }
    );

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(limiters.selfServiceMint.consume("198.51.100.7")).toMatchObject({
        allowed: true,
        resetAt: 61_000
      });
    }

    expect(limiters.selfServiceMint.consume("198.51.100.7")).toMatchObject({
      allowed: false,
      retryAfterSeconds: 60,
      resetAt: 61_000
    });
    // Another address mints freely, and no other bucket moved.
    expect(limiters.selfServiceMint.consume("198.51.100.8")).toMatchObject({ allowed: true });
    expect(limiters.protectedApi.consume("198.51.100.7")).toMatchObject({
      allowed: true,
      remaining: 59
    });

    now = 61_000;
    expect(limiters.selfServiceMint.consume("198.51.100.7")).toMatchObject({
      allowed: true,
      resetAt: 121_000
    });
  });

  it("rejects unsafe limiter configuration", () => {
    const base = {
      limit: 1,
      windowMs: 1_000,
      maxKeys: 1
    };

    for (const [field, value] of [
      ["limit", 0],
      ["limit", 1.5],
      ["limit", 10_001],
      ["windowMs", 0],
      ["windowMs", 1.5],
      ["windowMs", 86_400_001],
      ["maxKeys", 0],
      ["maxKeys", 1.5],
      ["maxKeys", 10_001]
    ] as const) {
      expect(() => new FixedWindowRateLimiter({ ...base, [field]: value })).toThrow(
        new RegExp(field)
      );
    }
  });
});
