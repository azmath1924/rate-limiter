import { randomUUID } from 'crypto';
import Redis, { Cluster } from 'ioredis';
import { ISlidingWindowStorage, SlidingWindowPeekParams, SlidingWindowPeekResult, SlideAndCheckParams, SlideAndCheckResult } from './ISlidingWindowStorage';
import { RedisBaseStorage } from './RedisBaseStorage';
import { StorageError } from '../errors';

type RedisClient = Redis | Cluster;

export class RedisSlidingWindowStorage extends RedisBaseStorage implements ISlidingWindowStorage {
  private scriptSha: string = '';
  private loadingPromise: Promise<void> | null = null;

  /**
   * Atomic sliding window check-and-record.
   *
   * Timestamp is sourced from Redis via TIME so all app instances share the
   * same clock — eliminating cross-instance clock skew entirely.
   */
  private static readonly LUA_SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local member = ARGV[3]

local time = redis.call('TIME')
local current_time = tonumber(time[1]) + tonumber(time[2]) / 1000000

redis.call('ZREMRANGEBYSCORE', key, 0, current_time - window)
local current_count = redis.call('ZCARD', key)
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')

if current_count < limit then
  redis.call('ZADD', key, current_time, member)
  redis.call('EXPIRE', key, window)

  local reset_time = current_time + window
  if oldest and #oldest > 0 then
    reset_time = tonumber(oldest[2]) + window
  end

  return {1, current_count + 1, limit - (current_count + 1), reset_time}
else
  local reset_time = current_time + window
  if oldest and #oldest > 0 then
    reset_time = tonumber(oldest[2]) + window
  end

  return {0, current_count, 0, reset_time}
end
  `;

  /**
   * Atomic window inspection.
   *
   * Prunes expired entries as a side effect (ZREMRANGEBYSCORE) so the count
   * is always accurate and uses the same redis.call('TIME') clock as LUA_SCRIPT.
   * Called via eval() directly — no SHA caching needed.
   */
  private static readonly PEEK_LUA_SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])

local time = redis.call('TIME')
local current_time = tonumber(time[1]) + tonumber(time[2]) / 1000000

redis.call('ZREMRANGEBYSCORE', key, 0, current_time - window)
local current_count = redis.call('ZCARD', key)
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')

local reset_time = current_time + window
if oldest and #oldest > 0 then
  reset_time = tonumber(oldest[2]) + window
end

return {current_count, math.max(0, limit - current_count), reset_time}
  `;

  constructor(client: RedisClient, prefix?: string, maxPendingCommands?: number) {
    super(client, prefix, maxPendingCommands);
  }

  private async ensureScriptLoaded(): Promise<void> {
    if (this.scriptSha) return;
    if (!this.loadingPromise) {
      this.loadingPromise = this.loadScript().finally(() => {
        this.loadingPromise = null;
      });
    }
    await this.loadingPromise;
  }

  private async loadScript(): Promise<void> {
    try {
      this.scriptSha = await this.execRedis(
        () => this.client.script('LOAD', RedisSlidingWindowStorage.LUA_SCRIPT) as Promise<string>
      );
    } catch (error) {
      throw new StorageError('Failed to load Lua script into Redis', { cause: error });
    }
  }

  async slideAndCheck(params: SlideAndCheckParams): Promise<SlideAndCheckResult> {
    const { key, limit, windowSeconds } = params;
    const redisKey = this.getSlidingWindowKey(key);
    const member = randomUUID();

    try {
      // If script loading fails, the catch block falls through to eval() below.
      await this.ensureScriptLoaded();

      const result = await this.execRedis(() =>
        this.client.evalsha(this.scriptSha, 1, redisKey, limit, windowSeconds, member)
      );

      if (Array.isArray(result) && result.length === 4) {
        const [allowed, count, remaining, resetTime] = result as [number, number, number, number];
        return { allowed: allowed === 1, currentCount: count, remaining, resetTime };
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('NOSCRIPT')) {
        // Script was flushed from Redis (restart or SCRIPT FLUSH) — reload and retry once.
        this.scriptSha = '';
        try {
          await this.ensureScriptLoaded();
        } catch {
          // reload also failed — fall through to eval()
        }

        if (this.scriptSha) {
          try {
            const retryResult = await this.execRedis(() =>
              this.client.evalsha(this.scriptSha, 1, redisKey, limit, windowSeconds, member)
            );
            if (Array.isArray(retryResult) && retryResult.length === 4) {
              const [allowed, count, remaining, resetTime] = retryResult as [number, number, number, number];
              return { allowed: allowed === 1, currentCount: count, remaining, resetTime };
            }
          } catch {
            // retry also failed — fall through to eval()
          }
        }
      }
      // non-NOSCRIPT errors and all NOSCRIPT fallthrough paths → eval()
    }

    return this.fallbackSlideAndCheck(params, redisKey, member);
  }

  private async fallbackSlideAndCheck(
    params: SlideAndCheckParams,
    redisKey: string,
    member: string
  ): Promise<SlideAndCheckResult> {
    const { limit, windowSeconds } = params;

    // eval() sends the script text directly — no pre-loading needed, fully atomic.
    const result = await this.execRedis(() =>
      this.client.eval(RedisSlidingWindowStorage.LUA_SCRIPT, 1, redisKey, limit, windowSeconds, member)
    );

    if (Array.isArray(result) && result.length === 4) {
      const [allowed, count, remaining, resetTime] = result as [number, number, number, number];
      // eval() also caches the script in Redis — restore the SHA for future evalsha calls.
      this.loadScript().catch((err) => {
        console.warn('[RedisSlidingWindowStorage] Failed to restore script SHA after eval() fallback:', err);
      });
      return { allowed: allowed === 1, currentCount: count, remaining, resetTime };
    }

    throw new StorageError('Invalid response from Redis eval()');
  }

  async peek(params: SlidingWindowPeekParams): Promise<SlidingWindowPeekResult> {
    const { key, limit, windowSeconds } = params;
    const redisKey = this.getSlidingWindowKey(key);

    // Uses a Lua script rather than a pipeline so the prune + count + oldest-entry
    // read is atomic and uses Redis TIME — consistent with slideAndCheck.
    const result = await this.execRedis(() =>
      this.client.eval(RedisSlidingWindowStorage.PEEK_LUA_SCRIPT, 1, redisKey, limit, windowSeconds)
    );

    if (!Array.isArray(result) || result.length !== 3) {
      throw new StorageError('Invalid response from Redis peek()');
    }

    const [currentCount, remaining, resetTime] = result as [number, number, number];
    return { currentCount, remaining, resetTime };
  }
}
