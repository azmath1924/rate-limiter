/**
 * Integration tests for the Token Bucket algorithm — require a real Redis instance.
 *
 * Start Redis before running:
 *   docker-compose up -d
 *
 * Run:
 *   npm run test:integration
 */

import Redis from 'ioredis';
import { RateLimiter } from '../../RateLimiter';
import { RedisTokenBucketStorage } from '../../storage/RedisTokenBucketStorage';
import { ITokenBucketStorage } from '../../storage/ITokenBucketStorage';
import { TokenBucketAlgorithm } from '../../core/algorithms/TokenBucket';
import { nowSeconds } from '../../utils';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const PREFIX = 'test:integration:tb:';

// ─── helpers ────────────────────────────────────────────────────────────────

function makeRedis(): Redis {
  return new Redis(REDIS_URL, { lazyConnect: true });
}

function makeLimiter(
  client: Redis,
  overrides: { capacity?: number; windowSeconds?: number } = {},
): RateLimiter<ITokenBucketStorage> {
  const storage = new RedisTokenBucketStorage(client, PREFIX);
  return new RateLimiter({
    storage,
    algorithm: new TokenBucketAlgorithm(),
    defaultLimit: overrides.capacity ?? 5,
    defaultWindow: overrides.windowSeconds ?? 60,
    failOpen: false,
  });
}

async function flushTestKeys(client: Redis): Promise<void> {
  const keys = await client.keys(`${PREFIX}*`);
  if (keys.length > 0) await client.del(...keys);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ─── suite ──────────────────────────────────────────────────────────────────

describe('Integration — Token Bucket, single instance', () => {
  let client: Redis;
  let limiter: RateLimiter<ITokenBucketStorage>;

  beforeAll(async () => {
    client = makeRedis();
    await client.connect();
    limiter = makeLimiter(client, { capacity: 5, windowSeconds: 60 });
  });

  afterAll(async () => {
    await flushTestKeys(client);
    await client.quit();
  });

  beforeEach(async () => {
    await flushTestKeys(client);
  });

  // ── basic allow / deny ───────────────────────────────────────────────────

  it('allows first request — fresh bucket starts at full capacity', async () => {
    const result = await limiter.check('user:1');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);        // capacity(5) - 1 consumed
    expect(result.currentCount).toBe(1);
    expect(result.limit).toBe(5);
    expect(result.windowSeconds).toBe(60);
  });

  it('remaining decrements by 1 per request', async () => {
    for (let i = 0; i < 4; i++) await limiter.check('user:1');
    const result = await limiter.check('user:1');
    expect(result.remaining).toBe(0);
    expect(result.currentCount).toBe(5);
    expect(result.allowed).toBe(true);       // 5th of 5 — still allowed
  });

  it('blocks the request that exceeds capacity', async () => {
    for (let i = 0; i < 5; i++) await limiter.check('user:1');
    const result = await limiter.check('user:1');
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('counts are isolated per identifier', async () => {
    for (let i = 0; i < 3; i++) await limiter.check('user:1');
    await limiter.check('user:2');

    const m1 = await limiter.getMetrics('user:1');
    const m2 = await limiter.getMetrics('user:2');

    expect(m1!.currentCount).toBe(3);
    expect(m2!.currentCount).toBe(1);
  });

  // ── burst behavior ───────────────────────────────────────────────────────

  it('full burst — all capacity consumed instantly, no refill between requests', async () => {
    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await limiter.check('user:burst');
      results.push(r.allowed);
    }
    expect(results.every(Boolean)).toBe(true);  // all 5 allowed

    const denied = await limiter.check('user:burst');
    expect(denied.allowed).toBe(false);         // 6th denied
  });

  it('after burst, bucket is empty — remaining is 0', async () => {
    for (let i = 0; i < 5; i++) await limiter.check('user:burst');
    const result = await limiter.check('user:burst');
    expect(result.remaining).toBe(0);
    expect(result.allowed).toBe(false);
  });

  // ── retryAfter ───────────────────────────────────────────────────────────

  it('retryAfter is undefined when request is allowed', async () => {
    const result = await limiter.check('user:1');
    expect(result.retryAfter).toBeUndefined();
  });

  it('retryAfter is a positive integer when bucket is empty', async () => {
    for (let i = 0; i < 5; i++) await limiter.check('user:1');
    const result = await limiter.check('user:1');
    expect(result.retryAfter).toBeDefined();
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  it('retryAfter reflects time until 1 token refills (≈ windowSeconds / capacity)', async () => {
    // capacity=5, windowSeconds=60 → refillRate=1/12 per sec → next token in ~12s
    for (let i = 0; i < 5; i++) await limiter.check('user:1');
    const result = await limiter.check('user:1');

    const expectedSeconds = Math.ceil(60 / 5); // 12
    expect(result.retryAfter).toBeGreaterThan(0);
    expect(result.retryAfter!).toBeLessThanOrEqual(expectedSeconds + 1); // ±1s tolerance
  });

  it('resetTime is in the future when bucket is empty', async () => {
    for (let i = 0; i < 5; i++) await limiter.check('user:1');
    const before = nowSeconds();
    const result = await limiter.check('user:1');
    expect(result.resetTime).toBeGreaterThan(before);
  });

  // ── peek ─────────────────────────────────────────────────────────────────

  it('peek on a fresh bucket returns full capacity without consuming a token', async () => {
    const status = await limiter.peek('user:1');
    expect(status.remaining).toBe(5);   // full bucket
    expect(status.currentCount).toBe(0);

    // Confirm no token was consumed
    const check = await limiter.check('user:1');
    expect(check.remaining).toBe(4);    // only 1 consumed (by check, not peek)
  });

  it('peek does not consume a token — multiple peeks leave count unchanged', async () => {
    await limiter.check('user:1');       // count = 1
    await limiter.peek('user:1');
    await limiter.peek('user:1');
    await limiter.peek('user:1');

    const result = await limiter.check('user:1');  // should be count = 2
    expect(result.currentCount).toBe(2);
    expect(result.remaining).toBe(3);
  });

  it('peek reflects current live bucket state', async () => {
    await limiter.check('user:1');
    await limiter.check('user:1');
    const status = await limiter.peek('user:1');
    expect(status.currentCount).toBe(2);
    expect(status.remaining).toBe(3);
  });

  it('peek returns remaining 0 when bucket is exhausted', async () => {
    for (let i = 0; i < 5; i++) await limiter.check('user:1');
    const status = await limiter.peek('user:1');
    expect(status.remaining).toBe(0);
    expect(status.currentCount).toBe(5);
  });

  it('peek returns limit and windowSeconds', async () => {
    const status = await limiter.peek('user:1');
    expect(status.limit).toBe(5);
    expect(status.windowSeconds).toBe(60);
  });

  // ── token refill (time-based) ─────────────────────────────────────────────

  it('tokens refill after the window elapses — bucket returns to full capacity', async () => {
    // capacity=3, windowSeconds=2 → refillRate=1.5 tokens/sec → full refill in 2s
    const shortLimiter = makeLimiter(client, { capacity: 3, windowSeconds: 2 });

    for (let i = 0; i < 3; i++) await shortLimiter.check('user:refill');
    const denied = await shortLimiter.check('user:refill');
    expect(denied.allowed).toBe(false);

    await sleep(2500); // wait for full refill

    const result = await shortLimiter.check('user:refill');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2); // 3 capacity - 1 just consumed
  }, 10_000);

  it('partial refill — tokens accumulate at refillRate between requests', async () => {
    // capacity=6, windowSeconds=3 → refillRate=2 tokens/sec
    // Exhaust 6 tokens, wait 1s → ~2 tokens refilled
    const shortLimiter = makeLimiter(client, { capacity: 6, windowSeconds: 3 });

    for (let i = 0; i < 6; i++) await shortLimiter.check('user:partial');

    await sleep(1500); // ~1.5s → ~3 tokens refilled

    const result = await shortLimiter.check('user:partial');
    expect(result.allowed).toBe(true);
    // After consuming 1 of the refilled tokens, remaining should be ≥ 1
    expect(result.remaining).toBeGreaterThanOrEqual(1);
  }, 10_000);

  it('bucket does not exceed capacity — tokens cap at capacity even after long wait', async () => {
    // capacity=3, windowSeconds=1 → full refill in 1s
    // Exhaust, then wait 5x the window — should still cap at 3
    const shortLimiter = makeLimiter(client, { capacity: 3, windowSeconds: 1 });

    for (let i = 0; i < 3; i++) await shortLimiter.check('user:cap');
    await sleep(5000); // wait 5x the full refill window

    // First request after long wait: remaining should be capacity-1, not more
    const result = await shortLimiter.check('user:cap');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2); // capped at 3, then -1 consumed
  }, 15_000);

  it('single token refills correctly — deny then wait one refill period then allow', async () => {
    // capacity=1, windowSeconds=2 → refillRate=0.5 tokens/sec → 1 token every 2s
    const tightLimiter = makeLimiter(client, { capacity: 1, windowSeconds: 2 });

    const first = await tightLimiter.check('user:single');
    expect(first.allowed).toBe(true);

    const denied = await tightLimiter.check('user:single');
    expect(denied.allowed).toBe(false);

    await sleep(2500); // wait for 1 token to refill

    const allowed = await tightLimiter.check('user:single');
    expect(allowed.allowed).toBe(true);
    expect(allowed.remaining).toBe(0); // 1 capacity - 1 consumed
  }, 10_000);

  // ── reset ─────────────────────────────────────────────────────────────────

  it('reset() clears bucket — next check starts at fresh full capacity', async () => {
    for (let i = 0; i < 5; i++) await limiter.check('user:1');

    await limiter.reset('user:1');

    const result = await limiter.check('user:1');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4); // fresh: 5 capacity - 1
    expect(result.currentCount).toBe(1);
  });

  it('reset() does not affect other identifiers', async () => {
    for (let i = 0; i < 3; i++) await limiter.check('user:1');
    await limiter.check('user:2');
    await limiter.reset('user:1');

    const m2 = await limiter.getMetrics('user:2');
    expect(m2!.currentCount).toBe(1);
  });

  it('reset() removes identifier from getMetrics', async () => {
    await limiter.check('user:1');
    expect(await limiter.getMetrics('user:1')).toBeDefined();

    await limiter.reset('user:1');
    expect(await limiter.getMetrics('user:1')).toBeUndefined();
  });

  // ── getMetrics ────────────────────────────────────────────────────────────

  it('getMetrics() returns undefined for identifier never checked', async () => {
    expect(await limiter.getMetrics('user:never')).toBeUndefined();
  });

  it('getMetrics() returns live bucket state after a check', async () => {
    await limiter.check('user:1');
    await limiter.check('user:1');
    const m = await limiter.getMetrics('user:1');
    expect(m).toBeDefined();
    expect(m!.currentCount).toBe(2);
    expect(m!.remaining).toBe(3);
    expect(m!.limit).toBe(5);
    expect(m!.windowSeconds).toBe(60);
    expect(m!.resetTime).toBeGreaterThan(0);
  });

  it('getMetrics() with no arg returns all checked identifiers', async () => {
    await limiter.check('user:1');
    await limiter.check('user:2');
    const all = await limiter.getMetrics();
    expect(all['user:1']).toBeDefined();
    expect(all['user:2']).toBeDefined();
  });

  it('getMetrics() with no arg reflects real bucket counts', async () => {
    await limiter.check('user:1');
    await limiter.check('user:1');
    await limiter.check('user:1');
    const all = await limiter.getMetrics();
    expect(all['user:1']!.currentCount).toBe(3);
    expect(all['user:1']!.remaining).toBe(2);
  });

  it('getMetrics() does not consume a token — peek-only', async () => {
    await limiter.check('user:1'); // count = 1
    await limiter.getMetrics('user:1');
    await limiter.getMetrics('user:1');
    const check = await limiter.check('user:1'); // should be count = 2
    expect(check.currentCount).toBe(2);
  });

  // ── per-call override ─────────────────────────────────────────────────────

  it('per-call capacity override is respected', async () => {
    for (let i = 0; i < 3; i++) {
      await limiter.check('user:override', { limit: 3, windowSeconds: 60 });
    }
    const result = await limiter.check('user:override', { limit: 3, windowSeconds: 60 });
    expect(result.allowed).toBe(false);
    expect(result.limit).toBe(3);
  });

  it('per-call windowSeconds override changes refill rate', async () => {
    // windowSeconds=120 → refillRate = 5/120 → next token in 24s
    const result = await limiter.check('user:1', { limit: 5, windowSeconds: 120 });
    expect(result.windowSeconds).toBe(120);
    // retryAfter after exhausting would be ~24s, not ~12s
    for (let i = 0; i < 4; i++) await limiter.check('user:1', { limit: 5, windowSeconds: 120 });
    const denied = await limiter.check('user:1', { limit: 5, windowSeconds: 120 });
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfter!).toBeGreaterThan(12); // more than the 60/5=12s default
  });

  // ── fail-open / fail-closed ───────────────────────────────────────────────

  it('failOpen: true — allows request and sets result.error when Redis unreachable', async () => {
    const deadClient = new Redis('redis://localhost:19999', {
      lazyConnect: true,
      commandTimeout: 300,
      maxRetriesPerRequest: 0,
    });
    const storage = new RedisTokenBucketStorage(deadClient, PREFIX);
    const failOpenLimiter = new RateLimiter({
      storage,
      algorithm: new TokenBucketAlgorithm(),
      defaultLimit: 5,
      failOpen: true,
    });

    const result = await failOpenLimiter.check('user:1');
    expect(result.allowed).toBe(true);
    expect(result.error).toBeDefined();

    deadClient.disconnect();
  }, 10_000);

  it('failOpen: false — throws when Redis unreachable', async () => {
    const deadClient = new Redis('redis://localhost:19999', {
      lazyConnect: true,
      commandTimeout: 300,
      maxRetriesPerRequest: 0,
    });
    const storage = new RedisTokenBucketStorage(deadClient, PREFIX);
    const failClosedLimiter = new RateLimiter({
      storage,
      algorithm: new TokenBucketAlgorithm(),
      defaultLimit: 5,
      failOpen: false,
    });

    await expect(failClosedLimiter.check('user:1')).rejects.toThrow();

    deadClient.disconnect();
  }, 10_000);

  // ── key prefix isolation ──────────────────────────────────────────────────

  it('two limiters with different prefixes on the same Redis do not interfere', async () => {
    const storageA = new RedisTokenBucketStorage(client, 'test:tb-prefix-a:');
    const storageB = new RedisTokenBucketStorage(client, 'test:tb-prefix-b:');
    const limiterA = new RateLimiter({ storage: storageA, algorithm: new TokenBucketAlgorithm(), defaultLimit: 3, failOpen: false });
    const limiterB = new RateLimiter({ storage: storageB, algorithm: new TokenBucketAlgorithm(), defaultLimit: 3, failOpen: false });

    for (let i = 0; i < 3; i++) await limiterA.check('user:1');
    const deniedA = await limiterA.check('user:1');
    expect(deniedA.allowed).toBe(false);

    // Different prefix — own independent bucket
    const allowedB = await limiterB.check('user:1');
    expect(allowedB.allowed).toBe(true);
    expect(allowedB.currentCount).toBe(1);

    const prefixKeys = await client.keys('test:tb-prefix-*');
    if (prefixKeys.length > 0) await client.del(...prefixKeys);
  });

  // ── healthCheck ───────────────────────────────────────────────────────────

  it('healthCheck() returns true when Redis is reachable', async () => {
    const storage = new RedisTokenBucketStorage(client, PREFIX);
    expect(await storage.healthCheck()).toBe(true);
  });

  it('healthCheck() returns false when Redis is unreachable', async () => {
    const deadClient = new Redis('redis://localhost:19999', {
      lazyConnect: true,
      commandTimeout: 300,
      maxRetriesPerRequest: 0,
    });
    const storage = new RedisTokenBucketStorage(deadClient, PREFIX);
    expect(await storage.healthCheck()).toBe(false);
    deadClient.disconnect();
  }, 10_000);

  // ── atomicity under concurrency ───────────────────────────────────────────

  it('concurrent requests do not exceed capacity due to race conditions', async () => {
    // Fire 20 concurrent requests against a capacity of 5.
    // Lua atomicity guarantees exactly 5 tokens consumed, never more.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => limiter.check('user:concurrent'))
    );
    const allowed = results.filter(r => r.allowed).length;
    expect(allowed).toBe(5);
  });

  it('concurrent requests from same identifier do not produce negative remaining', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => limiter.check('user:concurrent2'))
    );
    const deniedResults = results.filter(r => !r.allowed);
    deniedResults.forEach(r => expect(r.remaining).toBeGreaterThanOrEqual(0));
  });

  it('concurrent requests on different identifiers do not cause cross-identifier interference', async () => {
    const limA = makeLimiter(client, { capacity: 3, windowSeconds: 60 });

    const [resultsA, resultsB] = await Promise.all([
      Promise.all(Array.from({ length: 6 }, () => limA.check('user:iso-a'))),
      Promise.all(Array.from({ length: 6 }, () => limA.check('user:iso-b'))),
    ]);

    expect(resultsA.filter(r => r.allowed).length).toBe(3);
    expect(resultsB.filter(r => r.allowed).length).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Integration — Token Bucket, multiple instances sharing the same Redis', () => {
  let client: Redis;
  let instanceA: RateLimiter<ITokenBucketStorage>;
  let instanceB: RateLimiter<ITokenBucketStorage>;

  beforeAll(async () => {
    client = makeRedis();
    await client.connect();
  });

  beforeEach(async () => {
    await flushTestKeys(client);
    instanceA = makeLimiter(client, { capacity: 5, windowSeconds: 60 });
    instanceB = makeLimiter(client, { capacity: 5, windowSeconds: 60 });
  });

  afterAll(async () => {
    await flushTestKeys(client);
    await client.quit();
  });

  // ── shared state ──────────────────────────────────────────────────────────

  it('tokens consumed by instance A reduce the count seen by instance B', async () => {
    await instanceA.check('user:1');
    await instanceA.check('user:1');
    await instanceA.check('user:1');

    // B has never checked user:1 but Redis bucket has 3 tokens consumed
    const status = await instanceB.peek('user:1');
    expect(status.currentCount).toBe(3);
    expect(status.remaining).toBe(2);
  });

  it('capacity is enforced globally across both instances', async () => {
    await instanceA.check('user:1');
    await instanceA.check('user:1');
    await instanceA.check('user:1');
    await instanceB.check('user:1');
    await instanceB.check('user:1');

    // 6th request from either instance must be denied
    const fromA = await instanceA.check('user:1');
    expect(fromA.allowed).toBe(false);

    await instanceA.reset('user:1');

    await instanceA.check('user:1');
    await instanceA.check('user:1');
    await instanceA.check('user:1');
    await instanceB.check('user:1');
    await instanceB.check('user:1');

    const fromB = await instanceB.check('user:1');
    expect(fromB.allowed).toBe(false);
  });

  it('reset() on instance A is immediately visible to instance B', async () => {
    for (let i = 0; i < 5; i++) await instanceA.check('user:1');

    const beforeReset = await instanceB.peek('user:1');
    expect(beforeReset.currentCount).toBe(5);

    await instanceA.reset('user:1');

    const afterReset = await instanceB.peek('user:1');
    // After reset, bucket is gone — fresh peek returns full capacity
    expect(afterReset.remaining).toBe(5);
    expect(afterReset.currentCount).toBe(0);
  });

  // ── per-instance seenIdentifiers limitation ───────────────────────────────

  it('getMetrics() on instance B returns undefined for identifier only checked by A', async () => {
    await instanceA.check('user:1');
    expect(await instanceB.getMetrics('user:1')).toBeUndefined();
  });

  it('getMetrics() with no arg returns only identifiers seen by that instance', async () => {
    await instanceA.check('user:1');
    await instanceB.check('user:2');

    const allA = await instanceA.getMetrics();
    const allB = await instanceB.getMetrics();

    expect(allA['user:1']).toBeDefined();
    expect(allA['user:2']).toBeUndefined();
    expect(allB['user:2']).toBeDefined();
    expect(allB['user:1']).toBeUndefined();
  });

  it('getMetrics() for a specific identifier reads live Redis state regardless of which instance wrote it', async () => {
    await instanceA.check('user:1');
    await instanceA.check('user:1');
    await instanceA.check('user:1');

    // B checks once — now B's seenIdentifiers includes user:1
    await instanceB.check('user:1');

    // B sees the real count (4 total), not just its own 1 check
    const m = await instanceB.getMetrics('user:1');
    expect(m!.currentCount).toBe(4);
  });

  // ── concurrent cross-instance ────────────────────────────────────────────

  it('concurrent requests from both instances combined do not exceed capacity', async () => {
    const resultsA = Array.from({ length: 5 }, () => instanceA.check('user:concurrent'));
    const resultsB = Array.from({ length: 5 }, () => instanceB.check('user:concurrent'));

    const all = await Promise.all([...resultsA, ...resultsB]);
    const allowed = all.filter(r => r.allowed).length;

    // Lua atomicity: exactly 5 admitted, never more
    expect(allowed).toBe(5);
  });
});
