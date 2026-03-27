import Redis, { Cluster } from 'ioredis';
import { ITokenBucketStorage, TokenBucketParams, TokenBucketPeekResult, TokenBucketResult } from './ITokenBucketStorage';
import { RedisBaseStorage } from './RedisBaseStorage';
import { StorageError } from '../errors';

type RedisClient = Redis | Cluster;

export class RedisTokenBucketStorage extends RedisBaseStorage implements ITokenBucketStorage {
  private consumeScriptSha: string = '';
  private peekScriptSha: string = '';
  private consumeLoadingPromise: Promise<void> | null = null;
  private peekLoadingPromise: Promise<void> | null = null;

  /**
   * Atomic token bucket consume.
   *
   * Stores bucket state (tokens, last_refill) in a Redis HASH.
   * Refills tokens based on elapsed time using redis.call('TIME'),
   * then consumes one token if available.
   */
  private static readonly TOKEN_BUCKET_CONSUME_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])

local time = redis.call('TIME')
local now = tonumber(time[1]) + tonumber(time[2]) / 1000000

local data = redis.call('HMGET', key, 'tokens', 'last_refill')
local tokens = tonumber(data[1])
local last_refill = tonumber(data[2])

if tokens == nil then
  tokens = capacity
  last_refill = now
end

local elapsed = math.max(0, now - last_refill)
tokens = math.min(capacity, tokens + elapsed * refill_rate)

local allowed = 0
local reset_time = now + (1 / refill_rate)

if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
  reset_time = now + (1 / refill_rate)
end

local ttl = math.ceil(capacity / refill_rate) + 1
redis.call('HSET', key, 'tokens', tokens, 'last_refill', now)
redis.call('EXPIRE', key, ttl)

return {allowed, math.floor(tokens), reset_time}
  `;

  /**
   * Atomic token bucket peek — reads state without consuming a token.
   */
  private static readonly TOKEN_BUCKET_PEEK_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])

local time = redis.call('TIME')
local now = tonumber(time[1]) + tonumber(time[2]) / 1000000

local data = redis.call('HMGET', key, 'tokens', 'last_refill')
local tokens = tonumber(data[1])
local last_refill = tonumber(data[2])

if tokens == nil then
  return {capacity, now}
end

local elapsed = math.max(0, now - last_refill)
tokens = math.min(capacity, tokens + elapsed * refill_rate)

local reset_time = now + (1 / refill_rate)

return {math.floor(tokens), reset_time}
  `;

  constructor(client: RedisClient, prefix?: string, maxPendingCommands?: number) {
    super(client, prefix, maxPendingCommands);
  }

  // ─── Script loading (single-flight, EVALSHA caching) ────────────────────────

  private async ensureConsumeScriptLoaded(): Promise<void> {
    if (this.consumeScriptSha) return;
    if (!this.consumeLoadingPromise) {
      this.consumeLoadingPromise = this.loadConsumeScript().finally(() => {
        this.consumeLoadingPromise = null;
      });
    }
    await this.consumeLoadingPromise;
  }

  private async loadConsumeScript(): Promise<void> {
    try {
      this.consumeScriptSha = await this.execRedis(
        () => this.client.script('LOAD', RedisTokenBucketStorage.TOKEN_BUCKET_CONSUME_SCRIPT) as Promise<string>
      );
    } catch (error) {
      throw new StorageError('Failed to load token bucket consume Lua script into Redis', { cause: error });
    }
  }

  private async ensurePeekScriptLoaded(): Promise<void> {
    if (this.peekScriptSha) return;
    if (!this.peekLoadingPromise) {
      this.peekLoadingPromise = this.loadPeekScript().finally(() => {
        this.peekLoadingPromise = null;
      });
    }
    await this.peekLoadingPromise;
  }

  private async loadPeekScript(): Promise<void> {
    try {
      this.peekScriptSha = await this.execRedis(
        () => this.client.script('LOAD', RedisTokenBucketStorage.TOKEN_BUCKET_PEEK_SCRIPT) as Promise<string>
      );
    } catch (error) {
      throw new StorageError('Failed to load token bucket peek Lua script into Redis', { cause: error });
    }
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  async tokenBucketConsume(params: TokenBucketParams): Promise<TokenBucketResult> {
    const { key, capacity, refillRate } = params;
    const redisKey = this.getTokenBucketKey(key);

    try {
      await this.ensureConsumeScriptLoaded();

      const result = await this.execRedis(() =>
        this.client.evalsha(this.consumeScriptSha, 1, redisKey, capacity, refillRate)
      );

      if (Array.isArray(result) && result.length === 3) {
        const [allowed, remaining, resetTime] = result as [number, number, number];
        return { allowed: allowed === 1, remaining, resetTime };
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('NOSCRIPT')) {
        // Script was flushed (Redis restart or SCRIPT FLUSH) — reload and retry once.
        this.consumeScriptSha = '';
        try { await this.ensureConsumeScriptLoaded(); } catch { /* fall through to eval() */ }

        if (this.consumeScriptSha) {
          try {
            const retry = await this.execRedis(() =>
              this.client.evalsha(this.consumeScriptSha, 1, redisKey, capacity, refillRate)
            );
            if (Array.isArray(retry) && retry.length === 3) {
              const [allowed, remaining, resetTime] = retry as [number, number, number];
              return { allowed: allowed === 1, remaining, resetTime };
            }
          } catch { /* retry failed — fall through to eval() */ }
        }
      }
      // non-NOSCRIPT errors and all NOSCRIPT fallthrough paths → eval()
    }

    return this.fallbackConsume(redisKey, capacity, refillRate);
  }

  private async fallbackConsume(redisKey: string, capacity: number, refillRate: number): Promise<TokenBucketResult> {
    const result = await this.execRedis(() =>
      this.client.eval(RedisTokenBucketStorage.TOKEN_BUCKET_CONSUME_SCRIPT, 1, redisKey, capacity, refillRate)
    );

    if (Array.isArray(result) && result.length === 3) {
      const [allowed, remaining, resetTime] = result as [number, number, number];
      // eval() caches the script in Redis — restore SHA for future evalsha calls.
      this.loadConsumeScript().catch((err) => {
        console.warn('[RedisTokenBucketStorage] Failed to restore consume script SHA after eval() fallback:', err);
      });
      return { allowed: allowed === 1, remaining, resetTime };
    }

    throw new StorageError('Invalid response from Redis tokenBucketConsume()');
  }

  async tokenBucketPeek(params: TokenBucketParams): Promise<TokenBucketPeekResult> {
    const { key, capacity, refillRate } = params;
    const redisKey = this.getTokenBucketKey(key);

    try {
      await this.ensurePeekScriptLoaded();

      const result = await this.execRedis(() =>
        this.client.evalsha(this.peekScriptSha, 1, redisKey, capacity, refillRate)
      );

      if (Array.isArray(result) && result.length === 2) {
        const [remaining, resetTime] = result as [number, number];
        return { remaining, resetTime };
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('NOSCRIPT')) {
        this.peekScriptSha = '';
        try { await this.ensurePeekScriptLoaded(); } catch { /* fall through to eval() */ }

        if (this.peekScriptSha) {
          try {
            const retry = await this.execRedis(() =>
              this.client.evalsha(this.peekScriptSha, 1, redisKey, capacity, refillRate)
            );
            if (Array.isArray(retry) && retry.length === 2) {
              const [remaining, resetTime] = retry as [number, number];
              return { remaining, resetTime };
            }
          } catch { /* retry failed — fall through to eval() */ }
        }
      }
    }

    return this.fallbackPeek(redisKey, capacity, refillRate);
  }

  private async fallbackPeek(redisKey: string, capacity: number, refillRate: number): Promise<TokenBucketPeekResult> {
    const result = await this.execRedis(() =>
      this.client.eval(RedisTokenBucketStorage.TOKEN_BUCKET_PEEK_SCRIPT, 1, redisKey, capacity, refillRate)
    );

    if (Array.isArray(result) && result.length === 2) {
      const [remaining, resetTime] = result as [number, number];
      this.loadPeekScript().catch((err) => {
        console.warn('[RedisTokenBucketStorage] Failed to restore peek script SHA after eval() fallback:', err);
      });
      return { remaining, resetTime };
    }

    throw new StorageError('Invalid response from Redis tokenBucketPeek()');
  }
}
