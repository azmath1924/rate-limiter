import { ISlidingWindowStorage } from '../../storage/ISlidingWindowStorage';
import { IAlgorithm, AlgorithmCheckParams, AlgorithmResult } from './IAlgorithm';

export class SlidingWindowAlgorithm implements IAlgorithm<ISlidingWindowStorage> {

  async check(params: AlgorithmCheckParams<ISlidingWindowStorage>): Promise<AlgorithmResult> {
    const { storage, key, limit, windowSeconds } = params;
    const result = await storage.slideAndCheck({ key, limit, windowSeconds });
    return {
      allowed: result.allowed,
      currentCount: result.currentCount,
      remaining: result.remaining,
      resetTime: result.resetTime,
    };
  }

  async peek(params: AlgorithmCheckParams<ISlidingWindowStorage>): Promise<Omit<AlgorithmResult, 'allowed'>> {
    const { storage, key, limit, windowSeconds } = params;
    const status = await storage.peek({ key, limit, windowSeconds });
    return {
      currentCount: status.currentCount,
      remaining: status.remaining,
      resetTime: status.resetTime,
    };
  }
}
