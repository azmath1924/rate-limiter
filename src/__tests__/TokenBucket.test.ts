import { TokenBucketAlgorithm } from '../core/algorithms/TokenBucket';
import { ITokenBucketStorage, TokenBucketResult, TokenBucketPeekResult } from '../storage/ITokenBucketStorage';

const makeStorage = (
  consumeResult: TokenBucketResult,
  peekResult?: TokenBucketPeekResult
): ITokenBucketStorage => ({
  reset: jest.fn().mockResolvedValue(undefined),
  healthCheck: jest.fn().mockResolvedValue(true),
  tokenBucketConsume: jest.fn().mockResolvedValue(consumeResult),
  tokenBucketPeek: jest.fn().mockResolvedValue(
    peekResult ?? { remaining: consumeResult.remaining, resetTime: consumeResult.resetTime }
  ),
} as unknown as ITokenBucketStorage);

describe('TokenBucketAlgorithm', () => {
  const baseParams = { key: 'user:1', limit: 10, windowSeconds: 60 };
  let algorithm: TokenBucketAlgorithm;

  beforeEach(() => {
    algorithm = new TokenBucketAlgorithm();
  });

  describe('check()', () => {
    it('calls storage.tokenBucketConsume with correct capacity and refillRate', async () => {
      const storage = makeStorage({ allowed: true, remaining: 9, resetTime: 1000 });
      await algorithm.check({ ...baseParams, storage });
      expect(storage.tokenBucketConsume).toHaveBeenCalledWith({
        key: 'user:1',
        capacity: 10,
        refillRate: 10 / 60,
      });
    });

    it('returns allowed: true when token is available', async () => {
      const storage = makeStorage({ allowed: true, remaining: 9, resetTime: 1000 });
      const result = await algorithm.check({ ...baseParams, storage });
      expect(result.allowed).toBe(true);
    });

    it('returns allowed: false when bucket is empty', async () => {
      const storage = makeStorage({ allowed: false, remaining: 0, resetTime: 1060 });
      const result = await algorithm.check({ ...baseParams, storage });
      expect(result.allowed).toBe(false);
    });

    it('returns remaining from storage result', async () => {
      const storage = makeStorage({ allowed: true, remaining: 7, resetTime: 1000 });
      const result = await algorithm.check({ ...baseParams, storage });
      expect(result.remaining).toBe(7);
    });

    it('returns currentCount as capacity minus remaining', async () => {
      const storage = makeStorage({ allowed: true, remaining: 7, resetTime: 1000 });
      const result = await algorithm.check({ ...baseParams, storage });
      expect(result.currentCount).toBe(3); // 10 - 7
    });

    it('returns resetTime from storage result', async () => {
      const storage = makeStorage({ allowed: true, remaining: 9, resetTime: 9999 });
      const result = await algorithm.check({ ...baseParams, storage });
      expect(result.resetTime).toBe(9999);
    });

    it('propagates storage errors', async () => {
      const storage: ITokenBucketStorage = {
        reset: jest.fn(),
        healthCheck: jest.fn(),
        tokenBucketConsume: jest.fn().mockRejectedValue(new Error('Redis down')),
        tokenBucketPeek: jest.fn(),
      };
      await expect(algorithm.check({ ...baseParams, storage })).rejects.toThrow('Redis down');
    });
  });

  describe('peek()', () => {
    it('calls storage.tokenBucketPeek, not tokenBucketConsume', async () => {
      const storage = makeStorage(
        { allowed: true, remaining: 9, resetTime: 1000 },
        { remaining: 9, resetTime: 1000 }
      );
      await algorithm.peek({ ...baseParams, storage });
      expect(storage.tokenBucketPeek).toHaveBeenCalled();
      expect(storage.tokenBucketConsume).not.toHaveBeenCalled();
    });

    it('calls storage.tokenBucketPeek with correct capacity and refillRate', async () => {
      const storage = makeStorage(
        { allowed: true, remaining: 9, resetTime: 1000 },
        { remaining: 9, resetTime: 1000 }
      );
      await algorithm.peek({ ...baseParams, storage });
      expect(storage.tokenBucketPeek).toHaveBeenCalledWith({
        key: 'user:1',
        capacity: 10,
        refillRate: 10 / 60,
      });
    });

    it('returns remaining from storage result', async () => {
      const storage = makeStorage(
        { allowed: true, remaining: 0, resetTime: 1000 },
        { remaining: 5, resetTime: 1000 }
      );
      const result = await algorithm.peek({ ...baseParams, storage });
      expect(result.remaining).toBe(5);
    });

    it('returns currentCount as capacity minus remaining', async () => {
      const storage = makeStorage(
        { allowed: true, remaining: 0, resetTime: 1000 },
        { remaining: 5, resetTime: 1000 }
      );
      const result = await algorithm.peek({ ...baseParams, storage });
      expect(result.currentCount).toBe(5); // 10 - 5
    });

    it('returns resetTime from storage result', async () => {
      const storage = makeStorage(
        { allowed: true, remaining: 0, resetTime: 1000 },
        { remaining: 3, resetTime: 8888 }
      );
      const result = await algorithm.peek({ ...baseParams, storage });
      expect(result.resetTime).toBe(8888);
    });

    it('propagates storage errors', async () => {
      const storage: ITokenBucketStorage = {
        reset: jest.fn(),
        healthCheck: jest.fn(),
        tokenBucketConsume: jest.fn(),
        tokenBucketPeek: jest.fn().mockRejectedValue(new Error('Redis down')),
      };
      await expect(algorithm.peek({ ...baseParams, storage })).rejects.toThrow('Redis down');
    });
  });
});
