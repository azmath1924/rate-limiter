import Redis from 'ioredis';
import { RedisTokenBucketStorage } from '../storage/RedisTokenBucketStorage';
import { StorageError } from '../errors';

const makeClient = (overrides: Partial<Record<string, jest.Mock>> = {}): Redis => ({
  eval: jest.fn().mockResolvedValue([1, 4, 1060]),
  del: jest.fn().mockResolvedValue(1),
  ping: jest.fn().mockResolvedValue('PONG'),
  ...overrides,
} as unknown as Redis);

const tbBase = { key: 'user:1', capacity: 5, refillRate: 5 / 60 };

describe('RedisTokenBucketStorage', () => {
  describe('tokenBucketConsume()', () => {
    it('uses token bucket key with tb: infix to avoid collision with sliding window key', async () => {
      const client = makeClient({ eval: jest.fn().mockResolvedValue([1, 4, 1060]) });
      const storage = new RedisTokenBucketStorage(client, 'rl:');
      await storage.tokenBucketConsume(tbBase);
      expect(client.eval).toHaveBeenCalledWith(
        expect.any(String), 1, 'rl:tb:user:1',
        5, 5 / 60
      );
    });

    it('applies default prefix with tb: infix', async () => {
      const client = makeClient({ eval: jest.fn().mockResolvedValue([1, 4, 1060]) });
      const storage = new RedisTokenBucketStorage(client);
      await storage.tokenBucketConsume(tbBase);
      expect(client.eval).toHaveBeenCalledWith(
        expect.any(String), 1, 'ratelimit:tb:user:1',
        expect.any(Number), expect.any(Number)
      );
    });

    it('returns allowed: true when Lua returns 1', async () => {
      const client = makeClient({ eval: jest.fn().mockResolvedValue([1, 4, 1060]) });
      const storage = new RedisTokenBucketStorage(client);
      const result = await storage.tokenBucketConsume(tbBase);
      expect(result.allowed).toBe(true);
    });

    it('returns allowed: false when Lua returns 0', async () => {
      const client = makeClient({ eval: jest.fn().mockResolvedValue([0, 0, 1060]) });
      const storage = new RedisTokenBucketStorage(client);
      const result = await storage.tokenBucketConsume(tbBase);
      expect(result.allowed).toBe(false);
    });

    it('returns correct remaining and resetTime', async () => {
      const client = makeClient({ eval: jest.fn().mockResolvedValue([1, 3, 9999]) });
      const storage = new RedisTokenBucketStorage(client);
      const result = await storage.tokenBucketConsume(tbBase);
      expect(result.remaining).toBe(3);
      expect(result.resetTime).toBe(9999);
    });

    it('throws StorageError when eval returns unexpected format', async () => {
      const client = makeClient({ eval: jest.fn().mockResolvedValue('bad') });
      const storage = new RedisTokenBucketStorage(client);
      await expect(storage.tokenBucketConsume(tbBase)).rejects.toThrow(StorageError);
    });
  });

  describe('tokenBucketPeek()', () => {
    it('uses token bucket key with tb: infix', async () => {
      const client = makeClient({ eval: jest.fn().mockResolvedValue([4, 1060]) });
      const storage = new RedisTokenBucketStorage(client, 'rl:');
      await storage.tokenBucketPeek(tbBase);
      expect(client.eval).toHaveBeenCalledWith(
        expect.any(String), 1, 'rl:tb:user:1',
        5, 5 / 60
      );
    });

    it('returns correct remaining and resetTime', async () => {
      const client = makeClient({ eval: jest.fn().mockResolvedValue([3, 9999]) });
      const storage = new RedisTokenBucketStorage(client);
      const result = await storage.tokenBucketPeek(tbBase);
      expect(result.remaining).toBe(3);
      expect(result.resetTime).toBe(9999);
    });

    it('throws StorageError when eval returns unexpected format', async () => {
      const client = makeClient({ eval: jest.fn().mockResolvedValue('bad') });
      const storage = new RedisTokenBucketStorage(client);
      await expect(storage.tokenBucketPeek(tbBase)).rejects.toThrow(StorageError);
    });
  });

  describe('reset()', () => {
    it('deletes both the sliding window key and the token bucket key', async () => {
      const client = makeClient();
      const storage = new RedisTokenBucketStorage(client, 'rl:');
      await storage.reset('user:1');
      expect(client.del).toHaveBeenCalledWith('rl:sw:user:1', 'rl:tb:user:1');
    });

    it('applies default prefix to both keys', async () => {
      const client = makeClient();
      const storage = new RedisTokenBucketStorage(client);
      await storage.reset('user:1');
      expect(client.del).toHaveBeenCalledWith('ratelimit:sw:user:1', 'ratelimit:tb:user:1');
    });
  });

  describe('healthCheck()', () => {
    it('returns true when ping succeeds', async () => {
      const client = makeClient({ ping: jest.fn().mockResolvedValue('PONG') });
      const storage = new RedisTokenBucketStorage(client);
      expect(await storage.healthCheck()).toBe(true);
    });

    it('returns false when ping throws', async () => {
      const client = makeClient({ ping: jest.fn().mockRejectedValue(new Error('Connection refused')) });
      const storage = new RedisTokenBucketStorage(client);
      expect(await storage.healthCheck()).toBe(false);
    });
  });
});
