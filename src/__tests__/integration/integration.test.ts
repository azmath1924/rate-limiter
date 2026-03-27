/**
 * Integration tests — require a real Redis instance.
 *
 * Start Redis before running:
 *   docker-compose up -d
 *
 * Run:
 *   npm run test:integration
 */

import Redis from 'ioredis';
import { RateLimiter } from '../../RateLimiter';
import { RedisSlidingWindowStorage } from '../../storage/RedisSlidingWindowStorage';
import { nowSeconds } from '../../utils';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const PREFIX = 'test:integration:';

// ─── helpers ────────────────────────────────────────────────────────────────

function makeRedis(): Redis {
  return new Redis(REDIS_URL, { lazyConnect: true });
}

function makeLimiter(client: Redis, overrides: { limit?: number; window?: number } = {}): RateLimiter {
  const storage = new RedisSlidingWindowStorage(client, PREFIX);
  return new RateLimiter({
    storage,
    defaultLimit: overrides.limit ?? 5,
    defaultWindow: overrides.window ?? 60,
    failOpen: false,
  });
}

// Wipe all test keys between tests so state never bleeds across cases.
async function flushTestKeys(client: Redis): Promise<void> {
  const keys = await client.keys(`${PREFIX}*`);
  if (keys.length > 0) await client.del(...keys);
}

// ─── suite ──────────────────────────────────────────────────────────────────

describe('Integration — single instance', () => {
  let client: Redis;
  let limiter: RateLimiter;

  beforeAll(async () => {
    client = makeRedis();
    await client.connect();
    limiter = makeLimiter(client, { limit: 5, window: 10 });
  });

  afterAll(async () => {
    await flushTestKeys(client);
    await client.quit();
  });

  beforeEach(async () => {
    await flushTestKeys(client);
  });

  // ── basic allow / deny ───────────────────────────────────────────────────

  it('allows requests under the limit', async () => {
    const result = await limiter.check('user:1');
    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(1);
    expect(result.remaining).toBe(4);
  });

  it('blocks the request that exceeds the limit', async () => {
    for (let i = 0; i < 5; i++) await limiter.check('user:1');
    const result = await limiter.check('user:1');
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('counts are isolated per identifier', async () => {
    await limiter.check('user:1');
    await limiter.check('user:1');
    await limiter.check('user:2');

    const m1 = await limiter.getMetrics('user:1');
    const m2 = await limiter.getMetrics('user:2');

    expect(m1!.currentCount).toBe(2);
    expect(m2!.currentCount).toBe(1);
  });

  it('retryAfter is a positive number when denied', async () => {
    for (let i = 0; i < 5; i++) await limiter.check('user:1');
    const result = await limiter.check('user:1');
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  // ── peek ─────────────────────────────────────────────────────────────────

  it('peek() does not consume a slot', async () => {
    await limiter.check('user:1');        // count = 1
    await limiter.peek('user:1');
    await limiter.peek('user:1');
    const result = await limiter.check('user:1'); // should be 2, not 3
    expect(result.currentCount).toBe(2);
  });

  it('peek() returns current live state', async () => {
    await limiter.check('user:1');
    await limiter.check('user:1');
    const status = await limiter.peek('user:1');
    expect(status.currentCount).toBe(2);
    expect(status.remaining).toBe(3);
  });

  // ── reset ────────────────────────────────────────────────────────────────

  it('reset() clears the counter so next check starts from 1', async () => {
    for (let i = 0; i < 5; i++) await limiter.check('user:1');
    await limiter.reset('user:1');
    const result = await limiter.check('user:1');
    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(1);
  });

  it('reset() does not affect other identifiers', async () => {
    await limiter.check('user:1');
    await limiter.check('user:2');
    await limiter.reset('user:1');
    const m2 = await limiter.getMetrics('user:2');
    expect(m2!.currentCount).toBe(1);
  });

  // ── sliding window expiry ─────────────────────────────────────────────────

  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  it('entries expire after the window and allow new requests', async () => {
    const shortLimiter = makeLimiter(client, { limit: 3, window: 2 });

    await shortLimiter.check('user:exp');
    await shortLimiter.check('user:exp');
    await shortLimiter.check('user:exp');

    const denied = await shortLimiter.check('user:exp');
    expect(denied.allowed).toBe(false);

    // Wait for the full 2s window to expire
    await sleep(2500);

    const allowed = await shortLimiter.check('user:exp');
    expect(allowed.allowed).toBe(true);
    expect(allowed.currentCount).toBe(1);
  }, 10_000);

  it('request made just before window close is still counted', async () => {
    // window = 3s. Make a request at t=0, then at t=2s (1s before close).
    // At t=2s both entries should still be inside the window.
    const shortLimiter = makeLimiter(client, { limit: 5, window: 3 });

    await shortLimiter.check('user:boundary');
    await sleep(2000);

    const status = await shortLimiter.peek('user:boundary');
    expect(status.currentCount).toBe(1);   // t=0 entry still in window
    expect(status.remaining).toBe(4);
  }, 10_000);

  it('request made just after window close is pruned — count resets', async () => {
    // window = 2s. Fill 2 requests at t=0, wait 2.5s, check count.
    // Both entries should be pruned and count should be 0 before the new request.
    const shortLimiter = makeLimiter(client, { limit: 5, window: 2 });

    await shortLimiter.check('user:prune');
    await shortLimiter.check('user:prune');

    await sleep(2500);

    // After expiry peek should show count 0
    const status = await shortLimiter.peek('user:prune');
    expect(status.currentCount).toBe(0);
    expect(status.remaining).toBe(5);
  }, 10_000);

  it('burst at window boundary — limit refills exactly when oldest entry expires', async () => {
    // window = 2s, limit = 3.
    // t=0: fill all 3 slots → denied on 4th.
    // t=2.5s: all entries expired → all 3 slots refilled → exactly 3 allowed again.
    const shortLimiter = makeLimiter(client, { limit: 3, window: 2 });

    for (let i = 0; i < 3; i++) await shortLimiter.check('user:burst');
    const denied = await shortLimiter.check('user:burst');
    expect(denied.allowed).toBe(false);

    await sleep(2500);

    const results = await Promise.all([
      shortLimiter.check('user:burst'),
      shortLimiter.check('user:burst'),
      shortLimiter.check('user:burst'),
    ]);
    expect(results.every(r => r.allowed)).toBe(true);

    // 4th request in new window should be denied
    const deniedAgain = await shortLimiter.check('user:burst');
    expect(deniedAgain.allowed).toBe(false);
  }, 15_000);

  it('partial expiry — early entries pruned, recent entries remain', async () => {
    // window = 3s.
    // t=0:  3 requests → count = 3
    // t=1s: 2 more requests → count = 5
    // t=3.5s: the 3 early entries have expired, the 2 later ones remain.
    // Expected count = 2, remaining = 3.
    const shortLimiter = makeLimiter(client, { limit: 5, window: 3 });

    await shortLimiter.check('user:partial');
    await shortLimiter.check('user:partial');
    await shortLimiter.check('user:partial');

    await sleep(1000);

    await shortLimiter.check('user:partial');
    await shortLimiter.check('user:partial');

    await sleep(2700); // total ~3.7s — early 3 expired, late 2 still in window

    const status = await shortLimiter.peek('user:partial');
    expect(status.currentCount).toBe(2);
    expect(status.remaining).toBe(3);
  }, 15_000);

  // ── getMetrics ────────────────────────────────────────────────────────────

  it('getMetrics() with no arg returns all checked identifiers', async () => {
    await limiter.check('user:1');
    await limiter.check('user:2');
    const all = await limiter.getMetrics();
    expect(all['user:1']).toBeDefined();
    expect(all['user:2']).toBeDefined();
  });

  it('getMetrics() reflects live Redis state', async () => {
    await limiter.check('user:1');
    await limiter.check('user:1');
    await limiter.check('user:1');
    const m = await limiter.getMetrics('user:1');
    expect(m!.currentCount).toBe(3);
    expect(m!.remaining).toBe(2);
  });

  it('getMetrics() returns undefined for an identifier never checked', async () => {
    expect(await limiter.getMetrics('user:never')).toBeUndefined();
  });

  // ── atomicity under concurrency ───────────────────────────────────────────

  it('concurrent requests do not exceed the limit due to race conditions', async () => {
    // Fire 20 concurrent requests against a limit of 5.
    // Without Lua atomicity, multiple requests could read the same ZCARD
    // and all be admitted. With Lua, exactly 5 should be allowed.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => limiter.check('user:concurrent'))
    );
    const allowed = results.filter(r => r.allowed).length;
    expect(allowed).toBe(5);
  });

  it('concurrent load on different identifiers does not cause cross-identifier interference', async () => {
    // user:A and user:B each have limit 3. Fire 6 concurrent requests split evenly.
    // user:A being at limit must not block user:B.
    const limitedLimiter = makeLimiter(client, { limit: 3, window: 60 });

    const resultsA = await Promise.all(
      Array.from({ length: 6 }, () => limitedLimiter.check('user:iso-a'))
    );
    const resultsB = await Promise.all(
      Array.from({ length: 6 }, () => limitedLimiter.check('user:iso-b'))
    );

    expect(resultsA.filter(r => r.allowed).length).toBe(3);
    expect(resultsB.filter(r => r.allowed).length).toBe(3);
  });

  // ── fail-open / fail-closed ───────────────────────────────────────────────

  it('failOpen: true — allows request and sets result.error when Redis is unreachable', async () => {
    const deadClient = new Redis('redis://localhost:19999', {
      lazyConnect: true,
      commandTimeout: 300,
      maxRetriesPerRequest: 0,
    });
    const storage = new RedisSlidingWindowStorage(deadClient, PREFIX);
    const failOpenLimiter = new RateLimiter({ storage, defaultLimit: 5, failOpen: true });

    const result = await failOpenLimiter.check('user:1');
    expect(result.allowed).toBe(true);
    expect(result.error).toBeDefined();

    deadClient.disconnect();
  }, 10_000);

  it('failOpen: false — throws when Redis is unreachable', async () => {
    const deadClient = new Redis('redis://localhost:19999', {
      lazyConnect: true,
      commandTimeout: 300,
      maxRetriesPerRequest: 0,
    });
    const storage = new RedisSlidingWindowStorage(deadClient, PREFIX);
    const failClosedLimiter = new RateLimiter({ storage, defaultLimit: 5, failOpen: false });

    await expect(failClosedLimiter.check('user:1')).rejects.toThrow();

    deadClient.disconnect();
  }, 10_000);

  // ── retryAfter accuracy ───────────────────────────────────────────────────

  it('retryAfter reflects actual seconds until oldest entry expires', async () => {
    const shortLimiter = makeLimiter(client, { limit: 3, window: 10 });

    for (let i = 0; i < 3; i++) await shortLimiter.check('user:retry');

    const before = nowSeconds();
    const result = await shortLimiter.check('user:retry');
    expect(result.allowed).toBe(false);

    // retryAfter should be <= windowSeconds and > 0
    expect(result.retryAfter).toBeGreaterThan(0);
    expect(result.retryAfter!).toBeLessThanOrEqual(10);

    // resetTime should be in the future
    expect(result.resetTime).toBeGreaterThan(before);
  });

  // ── key prefix isolation ──────────────────────────────────────────────────

  it('two limiters with different prefixes on the same Redis do not interfere', async () => {
    const storageA = new RedisSlidingWindowStorage(client, 'test:prefix-a:');
    const storageB = new RedisSlidingWindowStorage(client, 'test:prefix-b:');
    const limiterA = new RateLimiter({ storage: storageA, defaultLimit: 3, failOpen: false });
    const limiterB = new RateLimiter({ storage: storageB, defaultLimit: 3, failOpen: false });

    // Fill limiter A to the limit
    for (let i = 0; i < 3; i++) await limiterA.check('user:1');
    const deniedA = await limiterA.check('user:1');
    expect(deniedA.allowed).toBe(false);

    // Limiter B uses a different prefix — same identifier key, different Redis key
    const allowedB = await limiterB.check('user:1');
    expect(allowedB.allowed).toBe(true);
    expect(allowedB.currentCount).toBe(1);

    // cleanup
    const prefixKeys = await client.keys('test:prefix-*');
    if (prefixKeys.length > 0) await client.del(...prefixKeys);
  });

  // ── per-call override ─────────────────────────────────────────────────────

  it('per-call limit override is respected end-to-end', async () => {
    // Constructor default is 5. Override to 2 on each call.
    for (let i = 0; i < 2; i++) {
      await limiter.check('user:override', { limit: 2, windowSeconds: 60 });
    }
    const result = await limiter.check('user:override', { limit: 2, windowSeconds: 60 });
    expect(result.allowed).toBe(false);
    expect(result.limit).toBe(2);
  });

  it('per-call windowSeconds override is respected end-to-end', async () => {
    const result = await limiter.check('user:win-override', { limit: 5, windowSeconds: 120 });
    expect(result.windowSeconds).toBe(120);
    expect(result.resetTime).toBeGreaterThan(nowSeconds() + 60);
  });

  // ── reset removes from seenIdentifiers ───────────────────────────────────

  it('reset() removes identifier from getMetrics', async () => {
    await limiter.check('user:reset-metrics');
    expect(await limiter.getMetrics('user:reset-metrics')).toBeDefined();

    await limiter.reset('user:reset-metrics');
    expect(await limiter.getMetrics('user:reset-metrics')).toBeUndefined();
  });

  // ── healthCheck ───────────────────────────────────────────────────────────

  it('healthCheck() returns true when Redis is reachable', async () => {
    const storage = new RedisSlidingWindowStorage(client, PREFIX);
    expect(await storage.healthCheck()).toBe(true);
  });

  it('healthCheck() returns false when Redis is unreachable', async () => {
    const deadClient = new Redis('redis://localhost:19999', {
      lazyConnect: true,
      commandTimeout: 300,
      maxRetriesPerRequest: 0,
    });
    const storage = new RedisSlidingWindowStorage(deadClient, PREFIX);
    expect(await storage.healthCheck()).toBe(false);
    deadClient.disconnect();
  }, 10_000);
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Integration — multiple instances sharing the same Redis', () => {
  let client: Redis;
  let instanceA: RateLimiter;
  let instanceB: RateLimiter;

  beforeAll(async () => {
    client = makeRedis();
    await client.connect();
  });

  beforeEach(async () => {
    await flushTestKeys(client);
    // Recreate instances each test so seenIdentifiers never bleeds between cases.
    instanceA = makeLimiter(client, { limit: 5, window: 60 });
    instanceB = makeLimiter(client, { limit: 5, window: 60 });
  });

  afterAll(async () => {
    await flushTestKeys(client);
    await client.quit();
  });

  // ── shared state ──────────────────────────────────────────────────────────

  it('requests on instance A count against the limit seen by instance B', async () => {
    await instanceA.check('user:1');
    await instanceA.check('user:1');
    await instanceA.check('user:1');

    // Instance B has never checked user:1 — but Redis has 3 entries.
    // peek() reads live Redis state regardless of which instance added them.
    const status = await instanceB.peek('user:1');
    expect(status.currentCount).toBe(3);
    expect(status.remaining).toBe(2);
  });

  it('limit is enforced globally across both instances', async () => {
    // 3 requests from A, 2 from B — should hit the limit of 5.
    await instanceA.check('user:1');
    await instanceA.check('user:1');
    await instanceA.check('user:1');
    await instanceB.check('user:1');
    await instanceB.check('user:1');

    // The 6th request from either instance must be denied.
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

  it('reset on instance A is immediately visible to instance B', async () => {
    for (let i = 0; i < 5; i++) await instanceA.check('user:1');

    // B sees the limit is hit
    const beforeReset = await instanceB.peek('user:1');
    expect(beforeReset.currentCount).toBe(5);

    await instanceA.reset('user:1');

    // B now sees a clean slate
    const afterReset = await instanceB.peek('user:1');
    expect(afterReset.currentCount).toBe(0);
  });

  // ── per-instance seenIdentifiers limitation ───────────────────────────────

  it('getMetrics() on instance B does not see identifiers only checked by A', async () => {
    await instanceA.check('user:1'); // only A knows about user:1

    // B has never checked user:1 — getMetrics returns undefined for it.
    expect(await instanceB.getMetrics('user:1')).toBeUndefined();
  });

  it('getMetrics() with no arg returns only identifiers seen by that instance', async () => {
    await instanceA.check('user:1');
    await instanceB.check('user:2');

    const allA = await instanceA.getMetrics();
    const allB = await instanceB.getMetrics();

    expect(allA['user:1']).toBeDefined();
    expect(allA['user:2']).toBeUndefined(); // A never checked user:2

    expect(allB['user:2']).toBeDefined();
    expect(allB['user:1']).toBeUndefined(); // B never checked user:1
  });

  it('getMetrics() for a specific identifier reads live Redis state regardless of instance', async () => {
    // A checks user:1 three times
    await instanceA.check('user:1');
    await instanceA.check('user:1');
    await instanceA.check('user:1');

    // B checks user:1 once — now B's seenIdentifiers includes user:1
    await instanceB.check('user:1');

    // B's getMetrics sees the real count (4), not just its own 1 check
    const m = await instanceB.getMetrics('user:1');
    expect(m!.currentCount).toBe(4);
  });

  // ── concurrent requests across instances ─────────────────────────────────

  it('concurrent requests from both instances combined do not exceed the limit', async () => {
    // 10 concurrent requests split across A and B, limit is 5.
    const resultsA = Array.from({ length: 5 }, () => instanceA.check('user:concurrent'));
    const resultsB = Array.from({ length: 5 }, () => instanceB.check('user:concurrent'));

    const all = await Promise.all([...resultsA, ...resultsB]);
    const allowed = all.filter(r => r.allowed).length;

    // Lua atomicity guarantees exactly 5 are admitted, never more.
    expect(allowed).toBe(5);
  });
});
