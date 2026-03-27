import { RateLimiter } from '../RateLimiter';
import { ISlidingWindowStorage, SlideAndCheckParams, SlideAndCheckResult, SlidingWindowPeekParams, SlidingWindowPeekResult } from '../storage/ISlidingWindowStorage';
import { ConfigurationError } from '../errors';
import { nowSeconds } from '../utils';

// Minimal in-memory ISlidingWindowStorage implementation for testing RateLimiter behaviour.
// Sources time from nowSeconds() — same as production storage would from Redis TIME.
const makeTestStorage = (): ISlidingWindowStorage => {
  const store = new Map<string, Array<{ timestamp: number }>>();
  return {
    async slideAndCheck({ key, limit, windowSeconds }: SlideAndCheckParams): Promise<SlideAndCheckResult> {
      const timestamp = nowSeconds();
      let entries = (store.get(key) ?? []).filter(e => e.timestamp > timestamp - windowSeconds);
      const currentCount = entries.length;
      if (currentCount < limit) {
        entries.push({ timestamp });
        store.set(key, entries);
        const resetTime = entries[0] ? entries[0].timestamp + windowSeconds : timestamp + windowSeconds;
        return { allowed: true, currentCount: currentCount + 1, remaining: limit - (currentCount + 1), resetTime };
      }
      const resetTime = entries[0] ? entries[0].timestamp + windowSeconds : timestamp + windowSeconds;
      return { allowed: false, currentCount, remaining: 0, resetTime };
    },
    async peek({ key, limit, windowSeconds }: SlidingWindowPeekParams): Promise<SlidingWindowPeekResult> {
      const timestamp = nowSeconds();
      const entries = (store.get(key) ?? []).filter(e => e.timestamp > timestamp - windowSeconds);
      const currentCount = entries.length;
      const resetTime = entries[0] ? entries[0].timestamp + windowSeconds : timestamp + windowSeconds;
      return { currentCount, remaining: Math.max(0, limit - currentCount), resetTime };
    },
    async reset(key: string): Promise<void> { store.delete(key); },
    async healthCheck(): Promise<boolean> { return true; },
  };
};

const makeBrokenStorage = (errorMessage = 'Redis down'): ISlidingWindowStorage => ({
  slideAndCheck: jest.fn().mockRejectedValue(new Error(errorMessage)),
  peek: jest.fn().mockRejectedValue(new Error(errorMessage)),
  reset: jest.fn().mockResolvedValue(undefined),
  healthCheck: jest.fn().mockResolvedValue(false),
});

describe('RateLimiter', () => {
  let storage: ISlidingWindowStorage;
  let limiter: RateLimiter;

  beforeEach(() => {
    storage = makeTestStorage();
    limiter = new RateLimiter({
      storage,
      defaultLimit: 5,
      defaultWindow: 60,
      failOpen: true,
    });
  });

  describe('check()', () => {
    it('allows request under the limit', async () => {
      const result = await limiter.check('user:1');
      expect(result.allowed).toBe(true);
    });

    it('blocks request at the limit', async () => {
      for (let i = 0; i < 5; i++) {
        await limiter.check('user:1');
      }
      const result = await limiter.check('user:1');
      expect(result.allowed).toBe(false);
    });

    it('returns correct limit and windowSeconds', async () => {
      const result = await limiter.check('user:1');
      expect(result.limit).toBe(5);
      expect(result.windowSeconds).toBe(60);
    });

    it('retryAfter is undefined when request is allowed', async () => {
      const result = await limiter.check('user:1');
      expect(result.retryAfter).toBeUndefined();
    });

    it('retryAfter is a positive number when request is denied', async () => {
      for (let i = 0; i < 5; i++) {
        await limiter.check('user:1');
      }
      const result = await limiter.check('user:1');
      expect(result.retryAfter).toBeDefined();
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it('per-call limit overrides constructor default', async () => {
      for (let i = 0; i < 3; i++) {
        await limiter.check('user:1', { limit: 3, windowSeconds: 60 });
      }
      const result = await limiter.check('user:1', { limit: 3, windowSeconds: 60 });
      expect(result.allowed).toBe(false);
      expect(result.limit).toBe(3);
    });

    it('per-call windowSeconds overrides constructor default', async () => {
      const result = await limiter.check('user:1', { limit: 5, windowSeconds: 120 });
      expect(result.windowSeconds).toBe(120);
    });

    it('missing per-call field falls back to constructor default', async () => {
      const result = await limiter.check('user:1', { limit: 10, windowSeconds: 60 });
      expect(result.limit).toBe(10);
      expect(result.windowSeconds).toBe(60);
    });
  });

  describe('isAllowed()', () => {
    it('returns true when under limit', async () => {
      expect(await limiter.isAllowed('user:1')).toBe(true);
    });

    it('returns false when at limit', async () => {
      for (let i = 0; i < 5; i++) {
        await limiter.isAllowed('user:1');
      }
      expect(await limiter.isAllowed('user:1')).toBe(false);
    });
  });

  describe('failOpen behavior', () => {
    it('failOpen: true → allows request when storage throws', async () => {
      const failOpenLimiter = new RateLimiter({
        storage: makeBrokenStorage(),
        failOpen: true,
      });
      const result = await failOpenLimiter.check('user:1');
      expect(result.allowed).toBe(true);
    });

    it('failOpen: true → remaining equals the configured limit', async () => {
      const failOpenLimiter = new RateLimiter({
        storage: makeBrokenStorage(),
        failOpen: true,
        defaultLimit: 10,
      });
      const result = await failOpenLimiter.check('user:1');
      expect(result.remaining).toBe(10);
    });

    it('failOpen: true → result.error contains the error message', async () => {
      const failOpenLimiter = new RateLimiter({
        storage: makeBrokenStorage('Redis down'),
        failOpen: true,
      });
      const result = await failOpenLimiter.check('user:1');
      expect(result.error).toBe('Redis down');
    });

    it('failOpen: false → error propagates when storage throws', async () => {
      const failClosedLimiter = new RateLimiter({
        storage: makeBrokenStorage('Redis down'),
        failOpen: false,
      });
      await expect(failClosedLimiter.check('user:1')).rejects.toThrow('Redis down');
    });
  });

  describe('peek()', () => {
    it('does not consume a slot', async () => {
      await limiter.peek('user:1');
      await limiter.peek('user:1');
      const result = await limiter.check('user:1');
      expect(result.currentCount).toBe(1);
    });

    it('returns currentCount, remaining, resetTime, limit, windowSeconds', async () => {
      await limiter.check('user:1');
      const result = await limiter.peek('user:1');
      expect(result.currentCount).toBe(1);
      expect(result.remaining).toBe(4);
      expect(result.resetTime).toBeDefined();
      expect(result.limit).toBe(5);
      expect(result.windowSeconds).toBe(60);
    });

    it('throws when storage throws — no fail-open on peek', async () => {
      const brokenPeekLimiter = new RateLimiter({
        storage: makeBrokenStorage('Redis down'),
        failOpen: true, // failOpen only applies to check(), not peek()
      });
      await expect(brokenPeekLimiter.peek('user:1')).rejects.toThrow('Redis down');
    });
  });

  describe('metrics', () => {
    it('returns undefined for an identifier that has never been checked', async () => {
      expect(await limiter.getMetrics('user:unknown')).toBeUndefined();
    });

    it('returns live Redis state after a check', async () => {
      await limiter.check('user:1');
      const m = await limiter.getMetrics('user:1');
      expect(m).toBeDefined();
      expect(m!.currentCount).toBe(1);
      expect(m!.remaining).toBe(4);
      expect(m!.limit).toBe(5);
      expect(m!.windowSeconds).toBe(60);
      expect(m!.resetTime).toBeGreaterThan(0);
    });

    it('reflects current count accurately as requests accumulate', async () => {
      await limiter.check('user:1');
      await limiter.check('user:1');
      await limiter.check('user:1');
      const m = await limiter.getMetrics('user:1');
      expect(m!.currentCount).toBe(3);
      expect(m!.remaining).toBe(2);
    });

    it('does not consume a slot — peek-only', async () => {
      await limiter.check('user:1'); // count = 1
      await limiter.getMetrics('user:1');
      await limiter.getMetrics('user:1');
      const check = await limiter.check('user:1'); // should be count = 2, not 3
      expect(check.currentCount).toBe(2);
    });

    it('getMetrics() with no arg returns all checked identifiers', async () => {
      await limiter.check('user:1');
      await limiter.check('user:2');
      const all = await limiter.getMetrics();
      expect(all['user:1']).toBeDefined();
      expect(all['user:2']).toBeDefined();
    });

    it('getMetrics() with no arg reflects real counts from Redis', async () => {
      await limiter.check('user:1');
      await limiter.check('user:1');
      const all = await limiter.getMetrics();
      expect(all['user:1']!.currentCount).toBe(2);
    });
  });

  describe('input validation', () => {
    it('throws ConfigurationError when limit is 0', async () => {
      await expect(limiter.check('user:1', { limit: 0, windowSeconds: 60 }))
        .rejects.toThrow(ConfigurationError);
    });

    it('throws ConfigurationError when limit is negative', async () => {
      await expect(limiter.check('user:1', { limit: -1, windowSeconds: 60 }))
        .rejects.toThrow(ConfigurationError);
    });

    it('throws ConfigurationError when windowSeconds is 0', async () => {
      await expect(limiter.check('user:1', { limit: 5, windowSeconds: 0 }))
        .rejects.toThrow(ConfigurationError);
    });

    it('throws ConfigurationError on peek() with invalid limit', async () => {
      await expect(limiter.peek('user:1', { limit: 0, windowSeconds: 60 }))
        .rejects.toThrow(ConfigurationError);
    });
  });

  describe('maxTrackedIdentifiers', () => {
    it('evicts oldest identifier when cap is reached', async () => {
      const m = new RateLimiter({ storage, defaultLimit: 100, maxTrackedIdentifiers: 2 });
      await m.check('user:1');
      await m.check('user:2');
      await m.check('user:3'); // evicts user:1
      expect(await m.getMetrics('user:1')).toBeUndefined();
      expect(await m.getMetrics('user:2')).toBeDefined();
      expect(await m.getMetrics('user:3')).toBeDefined();
    });

    it('does not evict when identifier is already tracked', async () => {
      const m = new RateLimiter({ storage, defaultLimit: 100, maxTrackedIdentifiers: 2 });
      await m.check('user:1');
      await m.check('user:2');
      await m.check('user:1'); // already in set — no eviction
      expect(await m.getMetrics('user:1')).toBeDefined();
      expect(await m.getMetrics('user:2')).toBeDefined();
    });

    it('tracks nothing when maxTrackedIdentifiers is 0', async () => {
      const m = new RateLimiter({ storage, defaultLimit: 100, maxTrackedIdentifiers: 0 });
      await m.check('user:1');
      expect(await m.getMetrics('user:1')).toBeUndefined();
      expect(await m.getMetrics()).toEqual({});
    });
  });

  describe('reset()', () => {
    it('clears storage so next check starts from count 1', async () => {
      for (let i = 0; i < 5; i++) {
        await limiter.check('user:1');
      }
      await limiter.reset('user:1');
      const result = await limiter.check('user:1');
      expect(result.allowed).toBe(true);
      expect(result.currentCount).toBe(1);
    });

    it('removes identifier from getMetrics after reset', async () => {
      const m = new RateLimiter({ storage });
      await m.check('user:1');
      await m.reset('user:1');
      expect(await m.getMetrics('user:1')).toBeUndefined();
    });

    it('does not affect other identifiers in getMetrics', async () => {
      const m = new RateLimiter({ storage, defaultLimit: 10 });
      await m.check('user:1');
      await m.check('user:2');
      await m.reset('user:1');
      expect(await m.getMetrics('user:2')).toBeDefined();
    });
  });
});
