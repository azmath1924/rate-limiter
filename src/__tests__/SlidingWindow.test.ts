import { SlidingWindowAlgorithm } from '../core/algorithms/SlidingWindow';
import { ISlidingWindowStorage, SlideAndCheckResult, SlidingWindowPeekResult } from '../storage/ISlidingWindowStorage';

const makeStorage = (
  slideResult: SlideAndCheckResult,
  peekResult?: SlidingWindowPeekResult
): ISlidingWindowStorage => ({
  slideAndCheck: jest.fn().mockResolvedValue(slideResult),
  peek: jest.fn().mockResolvedValue(peekResult ?? {
    currentCount: slideResult.currentCount,
    remaining: slideResult.remaining,
    resetTime: slideResult.resetTime,
  }),
  reset: jest.fn().mockResolvedValue(undefined),
  healthCheck: jest.fn().mockResolvedValue(true),
});

describe('SlidingWindowAlgorithm', () => {
  let algorithm: SlidingWindowAlgorithm;

  const baseParams = {
    key: 'user:1',
    limit: 5,
    windowSeconds: 60,
  };

  beforeEach(() => {
    algorithm = new SlidingWindowAlgorithm();
  });

  describe('check()', () => {
    it('calls storage.slideAndCheck with key, limit, windowSeconds', async () => {
      const storage = makeStorage({ allowed: true, currentCount: 1, remaining: 4, resetTime: 65 });

      await algorithm.check({ ...baseParams, storage });

      expect(storage.slideAndCheck).toHaveBeenCalledWith({
        key: 'user:1',
        limit: 5,
        windowSeconds: 60,
      });
    });

    it('does not pass timestamp — storage sources time from the datastore', async () => {
      const storage = makeStorage({ allowed: true, currentCount: 1, remaining: 4, resetTime: 65 });

      await algorithm.check({ ...baseParams, storage });

      const call = (storage.slideAndCheck as jest.Mock).mock.calls[0][0];
      expect(call).not.toHaveProperty('timestamp');
    });

    it('returns allowed from storage result', async () => {
      const storage = makeStorage({ allowed: true, currentCount: 1, remaining: 4, resetTime: 60 });
      const result = await algorithm.check({ ...baseParams, storage });
      expect(result.allowed).toBe(true);
    });

    it('returns allowed: false when storage returns false', async () => {
      const storage = makeStorage({ allowed: false, currentCount: 5, remaining: 0, resetTime: 60 });
      const result = await algorithm.check({ ...baseParams, storage });
      expect(result.allowed).toBe(false);
    });

    it('returns currentCount from storage result', async () => {
      const storage = makeStorage({ allowed: true, currentCount: 3, remaining: 2, resetTime: 60 });
      const result = await algorithm.check({ ...baseParams, storage });
      expect(result.currentCount).toBe(3);
    });

    it('returns remaining from storage result', async () => {
      const storage = makeStorage({ allowed: true, currentCount: 3, remaining: 2, resetTime: 60 });
      const result = await algorithm.check({ ...baseParams, storage });
      expect(result.remaining).toBe(2);
    });

    it('returns resetTime from storage result', async () => {
      const storage = makeStorage({ allowed: true, currentCount: 1, remaining: 4, resetTime: 9999 });
      const result = await algorithm.check({ ...baseParams, storage });
      expect(result.resetTime).toBe(9999);
    });

    it('does not call storage.peek', async () => {
      const storage = makeStorage({ allowed: true, currentCount: 1, remaining: 4, resetTime: 60 });
      await algorithm.check({ ...baseParams, storage });
      expect(storage.peek).not.toHaveBeenCalled();
    });

    it('propagates storage errors', async () => {
      const storage: ISlidingWindowStorage = {
        slideAndCheck: jest.fn().mockRejectedValue(new Error('Redis down')),
        peek: jest.fn(),
        reset: jest.fn(),
        healthCheck: jest.fn(),
      };
      await expect(algorithm.check({ ...baseParams, storage })).rejects.toThrow('Redis down');
    });
  });

  describe('peek()', () => {
    it('calls storage.peek, not storage.slideAndCheck', async () => {
      const storage = makeStorage(
        { allowed: true, currentCount: 1, remaining: 4, resetTime: 60 },
        { currentCount: 1, remaining: 4, resetTime: 60 }
      );

      await algorithm.peek({ ...baseParams, storage });

      expect(storage.peek).toHaveBeenCalled();
      expect(storage.slideAndCheck).not.toHaveBeenCalled();
    });

    it('calls storage.peek with key, limit, windowSeconds only', async () => {
      const storage = makeStorage(
        { allowed: true, currentCount: 1, remaining: 4, resetTime: 60 },
        { currentCount: 1, remaining: 4, resetTime: 60 }
      );

      await algorithm.peek({ ...baseParams, storage });

      const call = (storage.peek as jest.Mock).mock.calls[0][0];
      expect(call).toEqual({ key: 'user:1', limit: 5, windowSeconds: 60 });
      expect(call).not.toHaveProperty('timestamp');
    });

    it('returns currentCount from storage result', async () => {
      const storage = makeStorage(
        { allowed: true, currentCount: 0, remaining: 5, resetTime: 60 },
        { currentCount: 2, remaining: 3, resetTime: 60 }
      );
      const result = await algorithm.peek({ ...baseParams, storage });
      expect(result.currentCount).toBe(2);
    });

    it('returns remaining from storage result', async () => {
      const storage = makeStorage(
        { allowed: true, currentCount: 0, remaining: 5, resetTime: 60 },
        { currentCount: 2, remaining: 3, resetTime: 60 }
      );
      const result = await algorithm.peek({ ...baseParams, storage });
      expect(result.remaining).toBe(3);
    });

    it('returns resetTime from storage result', async () => {
      const storage = makeStorage(
        { allowed: true, currentCount: 0, remaining: 5, resetTime: 60 },
        { currentCount: 2, remaining: 3, resetTime: 1234 }
      );
      const result = await algorithm.peek({ ...baseParams, storage });
      expect(result.resetTime).toBe(1234);
    });

    it('propagates storage errors', async () => {
      const storage: ISlidingWindowStorage = {
        slideAndCheck: jest.fn(),
        peek: jest.fn().mockRejectedValue(new Error('Redis down')),
        reset: jest.fn(),
        healthCheck: jest.fn(),
      };
      await expect(algorithm.peek({ ...baseParams, storage })).rejects.toThrow('Redis down');
    });
  });
});
