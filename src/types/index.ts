import { IAlgorithm } from "../core/algorithms/IAlgorithm";
import { IBaseStorage } from "../storage/IBaseStorage";
import { ISlidingWindowStorage } from "../storage/ISlidingWindowStorage";

export interface RateLimitConfig {
  limit: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  currentCount: number;
  remaining: number;
  resetTime: number;
  retryAfter?: number;
  limit: number;
  windowSeconds: number;
  error?: string;
}

/** Live metrics for a single identifier — sourced from Redis, consistent across all instances. */
export interface MetricsResult {
  currentCount: number;
  remaining: number;
  resetTime: number;
  limit: number;
  windowSeconds: number;
}

/**
 * Public interface of RateLimiter, independent of storage type.
 * Use this as the parameter type anywhere that doesn't care which
 * algorithm or storage backend is in use (e.g. middleware, factories).
 */
export interface IRateLimiter {
  isAllowed(identifier: string, config?: Partial<RateLimitConfig>): Promise<boolean>;
  check(identifier: string, config?: Partial<RateLimitConfig>): Promise<RateLimitResult>;
  peek(identifier: string, config?: Partial<RateLimitConfig>): Promise<Omit<RateLimitResult, 'allowed'>>;
  reset(identifier: string): Promise<void>;
  getMetrics(identifier: string): Promise<MetricsResult | undefined>;
  getMetrics(): Promise<Record<string, MetricsResult>>;
}

/**
 * S ties the storage type to the algorithm type so the compiler rejects
 * mismatched pairs (e.g. TokenBucketAlgorithm + RedisSlidingWindowStorage)
 * at the point of construction rather than at runtime.
 *
 * Defaults to ISlidingWindowStorage so existing code that omits the type
 * parameter continues to work without change.
 */
export interface RateLimiterOptions<S extends IBaseStorage = ISlidingWindowStorage> {
  storage: S;
  algorithm?: IAlgorithm<S>;
  defaultLimit?: number;
  defaultWindow?: number;
  failOpen?: boolean;
  logger?: Pick<Console, 'error'>;
  /**
   * Maximum number of distinct identifiers tracked for `getMetrics()` with no argument.
   * When the cap is reached the oldest entry is evicted to make room for the new one.
   * Defaults to 10 000. Set to 0 to disable tracking entirely.
   */
  maxTrackedIdentifiers?: number;
}
