import { IBaseStorage } from './storage/IBaseStorage';
import { ISlidingWindowStorage } from './storage/ISlidingWindowStorage';
import { IAlgorithm } from './core/algorithms/IAlgorithm';
import { SlidingWindowAlgorithm } from './core/algorithms/SlidingWindow';
import { IRateLimiter, MetricsResult, RateLimitConfig, RateLimiterOptions, RateLimitResult } from './types';
import { ConfigurationError } from './errors';
import { nowSeconds } from './utils';


export class RateLimiter<S extends IBaseStorage = ISlidingWindowStorage> implements IRateLimiter {
  private readonly storage: S;
  private readonly algorithm: IAlgorithm<S>;
  private readonly defaultLimit: number;
  private readonly defaultWindow: number;
  private readonly failOpen: boolean;
  private readonly logger: Pick<Console, 'error'>;
  /**
   * Tracks identifiers that have been checked — used to support getMetrics() with no argument.
   * Bounded to maxTrackedIdentifiers; oldest entry is evicted when the cap is reached.
   */
  private readonly seenIdentifiers: Set<string>;
  private readonly maxTrackedIdentifiers: number;

  constructor(options: RateLimiterOptions<S>) {
    this.storage = options.storage;
    // When algorithm is omitted the caller is relying on the default (SlidingWindow).
    // The cast is unavoidable here: TypeScript cannot express "default only when S = ISlidingWindowStorage"
    // without overloads. The generic on RateLimiterOptions still enforces correctness when
    // an explicit algorithm is provided — which is the case that matters most.
    this.algorithm = options.algorithm ?? (new SlidingWindowAlgorithm() as unknown as IAlgorithm<S>);
    this.defaultLimit = options.defaultLimit ?? 100;
    this.defaultWindow = options.defaultWindow ?? 60;
    this.failOpen = options.failOpen ?? true;
    this.logger = options.logger ?? console;
    this.maxTrackedIdentifiers = options.maxTrackedIdentifiers ?? 1000;
    this.seenIdentifiers = new Set();
  }

  private validateConfig(limit: number, windowSeconds: number): void {
    if (limit <= 0) throw new ConfigurationError(`limit must be > 0, got ${limit}`);
    if (windowSeconds <= 0) throw new ConfigurationError(`windowSeconds must be > 0, got ${windowSeconds}`);
  }

  private trackIdentifier(identifier: string): void {
    if (this.maxTrackedIdentifiers === 0) return;
    if (!this.seenIdentifiers.has(identifier) && this.seenIdentifiers.size >= this.maxTrackedIdentifiers) {
      // Sets are insertion-ordered — evict the oldest entry.
      this.seenIdentifiers.delete(this.seenIdentifiers.values().next().value as string);
    }
    this.seenIdentifiers.add(identifier);
  }

  async isAllowed(identifier: string, config?: Partial<RateLimitConfig>): Promise<boolean> {
    const result = await this.check(identifier, config);
    return result.allowed;
  }

  async check(identifier: string, config?: Partial<RateLimitConfig>): Promise<RateLimitResult> {
    const limit = config?.limit ?? this.defaultLimit;
    const windowSeconds = config?.windowSeconds ?? this.defaultWindow;
    this.validateConfig(limit, windowSeconds);

    try {
      const result = await this.algorithm.check({
        storage: this.storage,
        key: identifier,
        limit,
        windowSeconds
      });

      this.trackIdentifier(identifier);

      // retryAfter mixes resetTime (Redis clock) with nowSeconds() (host clock).
      // In NTP-synced deployments the skew is sub-millisecond; Math.ceil absorbs it.
      const retryAfter = result.allowed
        ? undefined
        : Math.max(0, Math.ceil(result.resetTime - nowSeconds()));

      return {
        allowed: result.allowed,
        currentCount: result.currentCount,
        remaining: result.remaining,
        resetTime: result.resetTime,
        retryAfter,
        limit,
        windowSeconds
      };
    } catch (error) {
      this.logger.error('Rate limit check failed:', error);

      if (!this.failOpen) {
        throw error;
      }

      return {
        allowed: true,
        currentCount: 0,
        remaining: limit,
        resetTime: nowSeconds() + windowSeconds,
        limit,
        windowSeconds,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  async peek(identifier: string, config?: Partial<RateLimitConfig>): Promise<Omit<RateLimitResult, 'allowed'>> {
    const limit = config?.limit ?? this.defaultLimit;
    const windowSeconds = config?.windowSeconds ?? this.defaultWindow;
    this.validateConfig(limit, windowSeconds);

    const status = await this.algorithm.peek({
      storage: this.storage,
      key: identifier,
      limit,
      windowSeconds
    });

    return {
      currentCount: status.currentCount,
      remaining: status.remaining,
      resetTime: status.resetTime,
      limit,
      windowSeconds
    };
  }

  async reset(identifier: string): Promise<void> {
    try {
      await this.storage.reset(identifier);
    } finally {
      this.seenIdentifiers.delete(identifier);
    }
  }

  /**
   * Query live metrics from Redis.
   *
   * - `getMetrics('user:1')` → current window state for that identifier, or `undefined` if never checked.
   * - `getMetrics()` → current window state for every identifier seen by **this instance**.
   *
   * Results reflect real Redis state and are consistent across all instances.
   *
   * **Per-instance limitation:** `getMetrics()` with no argument only covers identifiers
   * that have been checked on this specific process. In a multi-instance deployment each
   * process tracks its own subset. For a global view across all instances, query Redis
   * directly (e.g. SCAN + ZCARD) or push metrics to an external aggregation system.
   *
   * Note: calling `getMetrics()` with no argument issues one Redis peek per tracked identifier.
   */
  async getMetrics(identifier: string): Promise<MetricsResult | undefined>;
  async getMetrics(): Promise<Record<string, MetricsResult>>;
  async getMetrics(identifier?: string): Promise<MetricsResult | undefined | Record<string, MetricsResult>> {
    return identifier !== undefined
      ? this.getMetricsForOne(identifier)
      : this.getMetricsForAll();
  }

  private async getMetricsForOne(identifier: string): Promise<MetricsResult | undefined> {
    if (!this.seenIdentifiers.has(identifier)) return undefined;
    return this.peek(identifier);
  }

  private async getMetricsForAll(): Promise<Record<string, MetricsResult>> {
    const ids = [...this.seenIdentifiers];
    const BATCH = 50; // cap concurrent Redis calls to avoid connection/memory spikes
    const result: Record<string, MetricsResult> = {};
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      const entries = await Promise.all(chunk.map(async (id) => [id, await this.peek(id)] as const));
      for (const [id, m] of entries) result[id] = m;
    }
    return result;
  }
}
