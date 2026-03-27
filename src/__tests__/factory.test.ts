import Redis, { Cluster } from 'ioredis';
import { createRateLimiter } from '../factory';
import { RateLimiter } from '../RateLimiter';
import { RedisSlidingWindowStorage } from '../storage/RedisSlidingWindowStorage';
import { ConfigurationError } from '../errors';

jest.mock('ioredis', () => ({
  default: jest.fn().mockImplementation(() => ({})),
  Cluster: jest.fn().mockImplementation(() => ({})),
  __esModule: true,
}));

jest.mock('../RateLimiter');
jest.mock('../storage/RedisSlidingWindowStorage');

const MockRedis = Redis as unknown as jest.Mock;
const MockCluster = Cluster as unknown as jest.Mock;
const MockRateLimiter = RateLimiter as jest.MockedClass<typeof RateLimiter>;
const MockRedisSlidingWindowStorage = RedisSlidingWindowStorage as jest.MockedClass<typeof RedisSlidingWindowStorage>;

describe('createRateLimiter()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env['REDIS_HOST'];
    delete process.env['REDIS_PORT'];
    delete process.env['REDIS_PASSWORD'];
    delete process.env['REDIS_DB'];
  });

  describe('storage selection', () => {
    it('uses provided Redis client directly — no new client created', () => {
      const redisClient = {} as Redis;
      createRateLimiter({ redis: redisClient });
      expect(MockRedisSlidingWindowStorage).toHaveBeenCalledWith(redisClient, undefined, undefined);
      expect(MockRedis).not.toHaveBeenCalled();
      expect(MockCluster).not.toHaveBeenCalled();
    });

    it('creates new Redis client from redisUrl with default commandTimeout', () => {
      createRateLimiter({ redisUrl: 'redis://localhost:6379' });
      expect(MockRedis).toHaveBeenCalledWith('redis://localhost:6379', { commandTimeout: 500, enableOfflineQueue: false });
      expect(MockRedisSlidingWindowStorage).toHaveBeenCalled();
    });

    it('creates Redis from env vars when no options provided', () => {
      process.env['REDIS_HOST'] = 'myhost';
      process.env['REDIS_PORT'] = '6380';
      process.env['REDIS_PASSWORD'] = 'secret';
      process.env['REDIS_DB'] = '2';

      createRateLimiter();

      expect(MockRedis).toHaveBeenCalledWith(expect.objectContaining({
        host: 'myhost',
        port: 6380,
        password: 'secret',
        db: 2,
        commandTimeout: 500,
      }));
    });

    it('uses default Redis config when env vars are not set', () => {
      createRateLimiter();
      expect(MockRedis).toHaveBeenCalledWith(expect.objectContaining({
        host: 'localhost',
        port: 6379,
        password: undefined,
        db: 0,
        commandTimeout: 500,
      }));
    });

    it('passes prefix to RedisSlidingWindowStorage when using provided client', () => {
      const redisClient = {} as Redis;
      createRateLimiter({ redis: redisClient, prefix: 'myapp:' });
      expect(MockRedisSlidingWindowStorage).toHaveBeenCalledWith(redisClient, 'myapp:', undefined);
    });

    it('passes prefix to RedisSlidingWindowStorage when using redisUrl', () => {
      createRateLimiter({ redisUrl: 'redis://localhost:6379', prefix: 'prod:' });
      expect(MockRedisSlidingWindowStorage).toHaveBeenCalledWith(expect.anything(), 'prod:', undefined);
    });
  });

  describe('commandTimeout', () => {
    it('defaults to 500ms for single-node connections', () => {
      createRateLimiter();
      expect(MockRedis).toHaveBeenCalledWith(expect.objectContaining({ commandTimeout: 500 }));
    });

    it('uses custom commandTimeout when provided', () => {
      createRateLimiter({ commandTimeout: 200 });
      expect(MockRedis).toHaveBeenCalledWith(expect.objectContaining({ commandTimeout: 200 }));
    });

    it('passes commandTimeout to redisUrl connections', () => {
      createRateLimiter({ redisUrl: 'redis://host:6379', commandTimeout: 100 });
      expect(MockRedis).toHaveBeenCalledWith('redis://host:6379', { commandTimeout: 100, enableOfflineQueue: false });
    });
  });

  describe('sentinel', () => {
    it('creates Redis client with sentinel config', () => {
      createRateLimiter({
        sentinel: {
          sentinels: [{ host: 's1', port: 26379 }, { host: 's2', port: 26379 }],
          name: 'mymaster',
          password: 'secret',
          db: 1,
        },
      });

      expect(MockRedis).toHaveBeenCalledWith(expect.objectContaining({
        sentinels: [{ host: 's1', port: 26379 }, { host: 's2', port: 26379 }],
        name: 'mymaster',
        password: 'secret',
        db: 1,
        commandTimeout: 500,
      }));
      expect(MockCluster).not.toHaveBeenCalled();
    });

    it('uses default master name "mymaster" when not specified', () => {
      createRateLimiter({
        sentinel: { sentinels: [{ host: 's1', port: 26379 }] },
      });
      expect(MockRedis).toHaveBeenCalledWith(expect.objectContaining({ name: 'mymaster' }));
    });

    it('applies custom commandTimeout to sentinel connection', () => {
      createRateLimiter({
        sentinel: { sentinels: [{ host: 's1', port: 26379 }] },
        commandTimeout: 300,
      });
      expect(MockRedis).toHaveBeenCalledWith(expect.objectContaining({ commandTimeout: 300 }));
    });
  });

  describe('cluster', () => {
    it('creates Cluster client with provided nodes', () => {
      const nodes = [{ host: 'n1', port: 7000 }, { host: 'n2', port: 7001 }];
      createRateLimiter({ cluster: { nodes } });

      expect(MockCluster).toHaveBeenCalledWith(
        nodes,
        expect.objectContaining({
          redisOptions: expect.objectContaining({ commandTimeout: 500 }),
        })
      );
      expect(MockRedis).not.toHaveBeenCalled();
    });

    it('merges caller clusterOptions with commandTimeout', () => {
      const nodes = [{ host: 'n1', port: 7000 }];
      createRateLimiter({
        cluster: { nodes, options: { scaleReads: 'slave' } },
        commandTimeout: 150,
      });

      expect(MockCluster).toHaveBeenCalledWith(
        nodes,
        expect.objectContaining({
          scaleReads: 'slave',
          redisOptions: expect.objectContaining({ commandTimeout: 150 }),
        })
      );
    });
  });

  describe('RateLimiter options', () => {
    it('passes storage instance to RateLimiter', () => {
      const redisClient = {} as Redis;
      createRateLimiter({ redis: redisClient });
      const storageInstance = MockRedisSlidingWindowStorage.mock.instances[0];
      expect(MockRateLimiter).toHaveBeenCalledWith(
        expect.objectContaining({ storage: storageInstance })
      );
    });

    it('passes defaultLimit to RateLimiter', () => {
      createRateLimiter({ defaultLimit: 50 });
      expect(MockRateLimiter).toHaveBeenCalledWith(
        expect.objectContaining({ defaultLimit: 50 })
      );
    });

    it('passes defaultWindow to RateLimiter', () => {
      createRateLimiter({ defaultWindow: 120 });
      expect(MockRateLimiter).toHaveBeenCalledWith(
        expect.objectContaining({ defaultWindow: 120 })
      );
    });

    it('passes failOpen: false to RateLimiter', () => {
      createRateLimiter({ failOpen: false });
      expect(MockRateLimiter).toHaveBeenCalledWith(
        expect.objectContaining({ failOpen: false })
      );
    });

  });

  describe('error handling', () => {
    it('wraps construction errors in ConfigurationError', () => {
      MockRedisSlidingWindowStorage.mockImplementationOnce(() => { throw new Error('bad config'); });
      expect(() => createRateLimiter()).toThrow(ConfigurationError);
    });

    it('preserves original error as cause', () => {
      const original = new Error('bad config');
      MockRedisSlidingWindowStorage.mockImplementationOnce(() => { throw original; });
      try {
        createRateLimiter();
      } catch (e) {
        expect((e as ConfigurationError).cause).toBe(original);
      }
    });
  });

  describe('return value', () => {
    it('returns a RateLimiter instance', () => {
      const result = createRateLimiter();
      expect(result).toBeInstanceOf(RateLimiter);
    });

    it('always returns a new instance per call', () => {
      const a = createRateLimiter();
      const b = createRateLimiter();
      expect(a).not.toBe(b);
    });
  });
});
