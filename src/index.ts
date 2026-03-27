// Core exports
export { RateLimiter } from './RateLimiter';
export { createRateLimiter, createTokenBucketRateLimiter } from './factory';
export type { CreateRateLimiterOptions, SentinelConfig, ClusterConfig } from './factory';

// Error exports
export { RateLimitError, StorageError, ConfigurationError } from './errors';

// Storage exports
export { IBaseStorage } from './storage/IBaseStorage';
export {
  ISlidingWindowStorage,
  SlideAndCheckParams,
  SlideAndCheckResult,
  SlidingWindowPeekParams,
  SlidingWindowPeekResult,
} from './storage/ISlidingWindowStorage';
export { ITokenBucketStorage, TokenBucketParams, TokenBucketResult, TokenBucketPeekResult } from './storage/ITokenBucketStorage';
export { RedisBaseStorage } from './storage/RedisBaseStorage';
export { RedisSlidingWindowStorage } from './storage/RedisSlidingWindowStorage';
export { RedisTokenBucketStorage } from './storage/RedisTokenBucketStorage';

// Algorithm exports
export { IAlgorithm } from './core/algorithms/IAlgorithm';
export { SlidingWindowAlgorithm } from './core/algorithms/SlidingWindow';
export { TokenBucketAlgorithm } from './core/algorithms/TokenBucket';

// Middleware exports
export { rateLimitMiddleware, ExpressMiddlewareOptions } from './middleware/express';

// Types (includes IRateLimiter, RateLimiterOptions, RateLimitResult, MetricsResult, etc.)
export * from './types';
