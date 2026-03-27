import Redis, { Cluster, ClusterNode, ClusterOptions, RedisOptions, SentinelAddress } from 'ioredis';
import { RateLimiter } from './RateLimiter';
import { RedisSlidingWindowStorage } from './storage/RedisSlidingWindowStorage';
import { RedisTokenBucketStorage } from './storage/RedisTokenBucketStorage';
import { TokenBucketAlgorithm } from './core/algorithms/TokenBucket';
import { ITokenBucketStorage } from './storage/ITokenBucketStorage';
import { ConfigurationError } from './errors';
import { RateLimiterOptions } from './types';

/** Sentinel connection — ioredis will auto-failover to the new primary. */
export interface SentinelConfig {
  sentinels: Array<Partial<SentinelAddress> & { host: string; port: number }>;
  /** Sentinel master group name (default: "mymaster") */
  name?: string;
  password?: string;
  db?: number;
}

/** Cluster connection — ioredis handles slot routing automatically. */
export interface ClusterConfig {
  nodes: ClusterNode[];
  options?: ClusterOptions;
}

export interface CreateRateLimiterOptions {
  /** Pass an already-constructed Redis / Cluster client. Takes precedence over all other connection options. */
  redis?: Redis | Cluster;
  /** Single-node: connect by URL e.g. "redis://localhost:6379" */
  redisUrl?: string;
  /** Single-node: connect by host/port/password/db (also read from env vars as fallback) */
  redisOptions?: RedisOptions;
  /** High-availability: Redis Sentinel */
  sentinel?: SentinelConfig;
  /** Horizontal scale: Redis Cluster */
  cluster?: ClusterConfig;
  /** Command timeout in milliseconds — how long to wait for a Redis reply before failing (default: 500) */
  commandTimeout?: number;
  /**
   * Max concurrent Redis commands per storage instance before new calls fail immediately.
   * Prevents the ioredis internal queue from growing without bound during Redis latency spikes.
   * Default: 100. Set to 0 to disable.
   */
  maxPendingCommands?: number;
  prefix?: string;
  defaultLimit?: number;
  defaultWindow?: number;
  failOpen?: boolean;
}

function buildRedisClient(options: CreateRateLimiterOptions): Redis | Cluster {
  const commandTimeout = options.commandTimeout ?? 500;

  if (options.redis) {
    return options.redis;
  }

  if (options.cluster) {
    return new Cluster(options.cluster.nodes, {
      ...options.cluster.options,
      redisOptions: {
        commandTimeout,
        offlineQueue: false,
        ...options.cluster.options?.redisOptions,
      },
    });
  }

  if (options.sentinel) {
    const { sentinels, name = 'mymaster', password, db } = options.sentinel;
    return new Redis({
      sentinels,
      name,
      password,
      db,
      commandTimeout,
    });
  }

  if (options.redisUrl) {
    return new Redis(options.redisUrl, { commandTimeout, enableOfflineQueue: false });
  }

  // Single-node: explicit options or env vars
  return new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASSWORD,
    db: parseInt(process.env.REDIS_DB ?? '0', 10),
    commandTimeout,
    enableOfflineQueue: false,
    ...options.redisOptions,
  });
}

/**
 * Convenience factory that wires up a Redis connection and returns a sliding-window
 * `RateLimiter` ready to use.
 *
 * For token-bucket rate limiting use `createTokenBucketRateLimiter()`.
 */
export function createRateLimiter(options: CreateRateLimiterOptions = {}): RateLimiter {
  try {
    const client = buildRedisClient(options);
    const storage = new RedisSlidingWindowStorage(client, options.prefix, options.maxPendingCommands);

    const rateLimiterOptions: RateLimiterOptions = {
      storage,
      defaultLimit: options.defaultLimit,
      defaultWindow: options.defaultWindow,
      failOpen: options.failOpen,
    };

    return new RateLimiter(rateLimiterOptions);
  } catch (error) {
    throw new ConfigurationError('Failed to create RateLimiter', { cause: error });
  }
}

/**
 * Convenience factory that wires up a Redis connection and returns a token-bucket
 * `RateLimiter` ready to use.
 *
 * `defaultLimit` = bucket capacity (max tokens).
 * `defaultWindow` = seconds to refill the full bucket (refillRate = capacity / window tokens/sec).
 *
 * For sliding-window rate limiting use `createRateLimiter()`.
 */
export function createTokenBucketRateLimiter(options: CreateRateLimiterOptions = {}): RateLimiter<ITokenBucketStorage> {
  try {
    const client = buildRedisClient(options);
    const storage = new RedisTokenBucketStorage(client, options.prefix, options.maxPendingCommands);

    const rateLimiterOptions: RateLimiterOptions<ITokenBucketStorage> = {
      storage,
      algorithm: new TokenBucketAlgorithm(),
      defaultLimit: options.defaultLimit,
      defaultWindow: options.defaultWindow,
      failOpen: options.failOpen,
    };

    return new RateLimiter<ITokenBucketStorage>(rateLimiterOptions);
  } catch (error) {
    throw new ConfigurationError('Failed to create TokenBucket RateLimiter', { cause: error });
  }
}
