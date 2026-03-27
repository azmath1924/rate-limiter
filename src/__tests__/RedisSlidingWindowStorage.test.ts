import Redis from 'ioredis';
import { RedisSlidingWindowStorage } from '../storage/RedisSlidingWindowStorage';
import { StorageError } from '../errors';

const SHA = 'abc123sha';
const NOSCRIPT = new Error('NOSCRIPT No matching script. Please use EVAL.');

const makeClient = (overrides: Partial<Record<string, jest.Mock>> = {}): Redis => ({
  script: jest.fn().mockResolvedValue(SHA),
  evalsha: jest.fn().mockResolvedValue([1, 1, 4, 1060]),
  eval: jest.fn().mockResolvedValue([1, 1, 4, 1060]),
  del: jest.fn().mockResolvedValue(1),
  ping: jest.fn().mockResolvedValue('PONG'),
  ...overrides,
} as unknown as Redis);

// base params: no timestamp — storage sources time from Redis internally
const base = { key: 'user:1', limit: 5, windowSeconds: 60 };

describe('RedisSlidingWindowStorage', () => {
  describe('slideAndCheck()', () => {
    describe('happy path via evalsha', () => {
      it('loads the script on first call', async () => {
        const client = makeClient();
        const storage = new RedisSlidingWindowStorage(client);
        await storage.slideAndCheck(base);
        expect(client.script).toHaveBeenCalledWith('LOAD', expect.any(String));
      });

      it('does not reload the script on subsequent calls', async () => {
        const client = makeClient();
        const storage = new RedisSlidingWindowStorage(client);
        await storage.slideAndCheck(base);
        await storage.slideAndCheck(base);
        expect(client.script).toHaveBeenCalledTimes(1);
      });

      it('calls evalsha with prefixed key, limit, windowSeconds, and a UUID member', async () => {
        const client = makeClient();
        const storage = new RedisSlidingWindowStorage(client, 'rl:');
        await storage.slideAndCheck(base);
        expect(client.evalsha).toHaveBeenCalledWith(
          SHA, 1, 'rl:sw:user:1', 5, 60, expect.any(String)
        );
      });

      it('does not pass a timestamp argument to evalsha — Redis sources time internally', async () => {
        const client = makeClient();
        const storage = new RedisSlidingWindowStorage(client);
        await storage.slideAndCheck(base);
        // Only 6 args: sha, numkeys, key, limit, windowSeconds, member
        expect((client.evalsha as jest.Mock).mock.calls[0]).toHaveLength(6);
      });

      it('returns allowed: true when Lua returns 1', async () => {
        const client = makeClient({ evalsha: jest.fn().mockResolvedValue([1, 1, 4, 1060]) });
        const storage = new RedisSlidingWindowStorage(client);
        const result = await storage.slideAndCheck(base);
        expect(result.allowed).toBe(true);
      });

      it('returns allowed: false when Lua returns 0', async () => {
        const client = makeClient({ evalsha: jest.fn().mockResolvedValue([0, 5, 0, 1060]) });
        const storage = new RedisSlidingWindowStorage(client);
        const result = await storage.slideAndCheck(base);
        expect(result.allowed).toBe(false);
      });

      it('returns correct currentCount, remaining, resetTime', async () => {
        const client = makeClient({ evalsha: jest.fn().mockResolvedValue([1, 3, 2, 9999]) });
        const storage = new RedisSlidingWindowStorage(client);
        const result = await storage.slideAndCheck(base);
        expect(result.currentCount).toBe(3);
        expect(result.remaining).toBe(2);
        expect(result.resetTime).toBe(9999);
      });

      it('falls back to eval() when evalsha returns unexpected format', async () => {
        const client = makeClient({
          evalsha: jest.fn().mockResolvedValue('not-an-array'),
          eval: jest.fn().mockResolvedValue([1, 1, 4, 1060]),
        });
        const storage = new RedisSlidingWindowStorage(client);
        const result = await storage.slideAndCheck(base);
        expect(client.eval).toHaveBeenCalled();
        expect(result.allowed).toBe(true);
      });
    });

    describe('NOSCRIPT recovery', () => {
      it('clears scriptSha and reloads on NOSCRIPT', async () => {
        const client = makeClient({
          evalsha: jest.fn()
            .mockRejectedValueOnce(NOSCRIPT)
            .mockResolvedValue([1, 1, 4, 1060]),
        });
        const storage = new RedisSlidingWindowStorage(client);
        await storage.slideAndCheck(base);
        // script loaded twice: initial load + reload after NOSCRIPT
        expect(client.script).toHaveBeenCalledTimes(2);
      });

      it('returns result from retry evalsha after reload', async () => {
        const client = makeClient({
          evalsha: jest.fn()
            .mockRejectedValueOnce(NOSCRIPT)
            .mockResolvedValue([1, 2, 3, 1060]),
        });
        const storage = new RedisSlidingWindowStorage(client);
        const result = await storage.slideAndCheck(base);
        expect(result.allowed).toBe(true);
        expect(result.currentCount).toBe(2);
      });

      it('falls back to eval() when retry evalsha also fails', async () => {
        const client = makeClient({
          evalsha: jest.fn().mockRejectedValue(NOSCRIPT),
          eval: jest.fn().mockResolvedValue([1, 1, 4, 1060]),
        });
        const storage = new RedisSlidingWindowStorage(client);
        await storage.slideAndCheck(base);
        expect(client.eval).toHaveBeenCalled();
      });

      it('falls back to eval() when reload fails after NOSCRIPT', async () => {
        const client = makeClient({
          // initial load succeeds so evalsha is attempted; reload after NOSCRIPT fails
          script: jest.fn()
            .mockResolvedValueOnce('abc123')
            .mockRejectedValue(new Error('Redis down')),
          evalsha: jest.fn().mockRejectedValueOnce(NOSCRIPT),
          eval: jest.fn().mockResolvedValue([1, 1, 4, 1060]),
        });
        const storage = new RedisSlidingWindowStorage(client);
        await storage.slideAndCheck(base);
        expect(client.eval).toHaveBeenCalled();
      });
    });

    describe('eval() fallback', () => {
      it('calls eval() with the Lua script text and no timestamp arg', async () => {
        const client = makeClient({
          evalsha: jest.fn().mockRejectedValue(NOSCRIPT),
          eval: jest.fn().mockResolvedValue([1, 1, 4, 1060]),
        });
        const storage = new RedisSlidingWindowStorage(client);
        await storage.slideAndCheck(base);
        expect(client.eval).toHaveBeenCalledWith(
          expect.stringContaining('ZREMRANGEBYSCORE'),
          1,
          expect.any(String), // redisKey
          5, 60,              // limit, windowSeconds — no timestamp
          expect.any(String)  // member (UUID)
        );
      });

      it('reloads script after eval() succeeds', async () => {
        const client = makeClient({
          evalsha: jest.fn().mockRejectedValue(NOSCRIPT),
          eval: jest.fn().mockResolvedValue([1, 1, 4, 1060]),
        });
        const storage = new RedisSlidingWindowStorage(client);
        await storage.slideAndCheck(base);
        // Wait for the fire-and-forget loadScript() to complete
        await new Promise(resolve => setTimeout(resolve, 10));
        // script: initial load + reload after NOSCRIPT + restore after eval
        expect(client.script).toHaveBeenCalledTimes(3);
      });

      it('returns allowed: true from eval() result', async () => {
        const client = makeClient({
          evalsha: jest.fn().mockRejectedValue(NOSCRIPT),
          eval: jest.fn().mockResolvedValue([1, 1, 4, 1060]),
        });
        const storage = new RedisSlidingWindowStorage(client);
        const result = await storage.slideAndCheck(base);
        expect(result.allowed).toBe(true);
      });
    });

    describe('key prefixing', () => {
      it('applies default prefix "ratelimit:"', async () => {
        const client = makeClient();
        const storage = new RedisSlidingWindowStorage(client);
        await storage.slideAndCheck(base);
        expect(client.evalsha).toHaveBeenCalledWith(
          expect.any(String), 1, 'ratelimit:sw:user:1',
          expect.any(Number), expect.any(Number), expect.any(String)
        );
      });

      it('applies custom prefix', async () => {
        const client = makeClient();
        const storage = new RedisSlidingWindowStorage(client, 'prod:v2:');
        await storage.slideAndCheck(base);
        expect(client.evalsha).toHaveBeenCalledWith(
          expect.any(String), 1, 'prod:v2:sw:user:1',
          expect.any(Number), expect.any(Number), expect.any(String)
        );
      });
    });

    describe('ensureScriptLoaded() deduplication', () => {
      it('shares one loadScript() call across concurrent requests', async () => {
        let resolveLoad!: (sha: string) => void;
        const loadPromise = new Promise<string>(res => { resolveLoad = res; });

        const client = makeClient({
          script: jest.fn().mockReturnValue(loadPromise),
          evalsha: jest.fn().mockResolvedValue([1, 1, 4, 1060]),
        });
        const storage = new RedisSlidingWindowStorage(client);

        const p1 = storage.slideAndCheck(base);
        const p2 = storage.slideAndCheck(base);
        const p3 = storage.slideAndCheck(base);

        resolveLoad(SHA);
        await Promise.all([p1, p2, p3]);

        expect(client.script).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('peek()', () => {
    it('calls eval() with the peek Lua script', async () => {
      const client = makeClient({ eval: jest.fn().mockResolvedValue([2, 3, 1060]) });
      const storage = new RedisSlidingWindowStorage(client);
      await storage.peek(base);
      expect(client.eval).toHaveBeenCalledWith(
        expect.stringContaining('ZREMRANGEBYSCORE'),
        1,
        'ratelimit:sw:user:1',
        5, 60
      );
    });

    it('does not pass a timestamp argument — Redis sources time internally', async () => {
      const client = makeClient({ eval: jest.fn().mockResolvedValue([0, 5, 1060]) });
      const storage = new RedisSlidingWindowStorage(client);
      await storage.peek(base);
      // Only 5 args: script, numkeys, key, limit, windowSeconds
      expect((client.eval as jest.Mock).mock.calls[0]).toHaveLength(5);
    });

    it('uses prefixed key', async () => {
      const client = makeClient({ eval: jest.fn().mockResolvedValue([0, 5, 1060]) });
      const storage = new RedisSlidingWindowStorage(client, 'rl:');
      await storage.peek(base);
      expect(client.eval).toHaveBeenCalledWith(
        expect.any(String), 1, 'rl:sw:user:1', 5, 60
      );
    });

    it('returns currentCount from Lua result', async () => {
      const client = makeClient({ eval: jest.fn().mockResolvedValue([3, 2, 1060]) });
      const storage = new RedisSlidingWindowStorage(client);
      const result = await storage.peek(base);
      expect(result.currentCount).toBe(3);
    });

    it('returns remaining from Lua result', async () => {
      const client = makeClient({ eval: jest.fn().mockResolvedValue([2, 3, 1060]) });
      const storage = new RedisSlidingWindowStorage(client);
      const result = await storage.peek(base);
      expect(result.remaining).toBe(3);
    });

    it('returns resetTime from Lua result', async () => {
      const client = makeClient({ eval: jest.fn().mockResolvedValue([1, 4, 9999]) });
      const storage = new RedisSlidingWindowStorage(client);
      const result = await storage.peek(base);
      expect(result.resetTime).toBe(9999);
    });

    it('throws StorageError when eval returns unexpected format', async () => {
      const client = makeClient({ eval: jest.fn().mockResolvedValue('bad') });
      const storage = new RedisSlidingWindowStorage(client);
      await expect(storage.peek(base)).rejects.toThrow(StorageError);
    });
  });

  describe('reset()', () => {
    it('deletes both the sliding window key and the token bucket key', async () => {
      const client = makeClient();
      const storage = new RedisSlidingWindowStorage(client, 'rl:');
      await storage.reset('user:1');
      expect(client.del).toHaveBeenCalledWith('rl:sw:user:1', 'rl:tb:user:1');
    });

    it('applies default prefix to both keys', async () => {
      const client = makeClient();
      const storage = new RedisSlidingWindowStorage(client);
      await storage.reset('user:1');
      expect(client.del).toHaveBeenCalledWith('ratelimit:sw:user:1', 'ratelimit:tb:user:1');
    });
  });

  describe('healthCheck()', () => {
    it('returns true when ping succeeds', async () => {
      const client = makeClient({ ping: jest.fn().mockResolvedValue('PONG') });
      const storage = new RedisSlidingWindowStorage(client);
      expect(await storage.healthCheck()).toBe(true);
    });

    it('returns false when ping throws', async () => {
      const client = makeClient({ ping: jest.fn().mockRejectedValue(new Error('Connection refused')) });
      const storage = new RedisSlidingWindowStorage(client);
      expect(await storage.healthCheck()).toBe(false);
    });
  });
});
