import Redis, { Cluster } from 'ioredis';
import { StorageError } from '../errors';

export type RedisClient = Redis | Cluster;

/**
 * Shared base for Redis storage implementations.
 *
 * Owns the client, key prefix, and the two key-builder helpers so both
 * algorithm-specific subclasses use identical namespacing:
 *   sliding window → {prefix}sw:{key}
 *   token bucket   → {prefix}tb:{key}
 *
 * reset() deletes both keys so it works correctly regardless of which
 * algorithm is currently in use against a given identifier.
 *
 * execRedis() wraps every client call with a pending-command cap so the
 * ioredis internal queue cannot grow without bound under Redis latency spikes.
 * When the cap is reached, calls fail immediately (triggering failOpen instead
 * of queuing indefinitely and risking OOM).
 */
export abstract class RedisBaseStorage {
  protected readonly client: RedisClient;
  protected readonly prefix: string;
  private readonly maxPendingCommands: number;
  private pendingCommands: number = 0;

  constructor(client: RedisClient, prefix: string = 'ratelimit:', maxPendingCommands: number = 100) {
    this.client = client;
    this.prefix = prefix;
    this.maxPendingCommands = maxPendingCommands;
  }

  /**
   * Executes a Redis call with a concurrency guard.
   * Throws StorageError immediately when pending commands exceed the cap
   * rather than letting the ioredis queue grow unboundedly.
   */
  protected async execRedis<T>(fn: () => Promise<T>): Promise<T> {
    if (this.pendingCommands >= this.maxPendingCommands) {
      throw new StorageError(
        `Redis command queue saturated (${this.maxPendingCommands} commands pending) — failing fast`
      );
    }
    this.pendingCommands++;
    try {
      return await fn();
    } finally {
      this.pendingCommands--;
    }
  }

  protected getSlidingWindowKey(key: string): string {
    return `${this.prefix}sw:${key}`;
  }

  protected getTokenBucketKey(key: string): string {
    return `${this.prefix}tb:${key}`;
  }

  async reset(key: string): Promise<void> {
    await this.execRedis(() =>
      this.client.del(this.getSlidingWindowKey(key), this.getTokenBucketKey(key))
    );
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.execRedis(() => this.client.ping());
      return true;
    } catch {
      return false;
    }
  }
}
