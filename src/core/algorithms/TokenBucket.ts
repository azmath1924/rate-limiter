import { ITokenBucketStorage } from '../../storage/ITokenBucketStorage';
import { IAlgorithm, AlgorithmCheckParams, AlgorithmResult } from './IAlgorithm';

export class TokenBucketAlgorithm implements IAlgorithm<ITokenBucketStorage> {

  async check(params: AlgorithmCheckParams<ITokenBucketStorage>): Promise<AlgorithmResult> {
    const { storage, key, limit, windowSeconds } = params;
    const capacity = limit;
    const refillRate = limit / windowSeconds;
    const result = await storage.tokenBucketConsume({ key, capacity, refillRate });
    return {
      allowed: result.allowed,
      currentCount: capacity - result.remaining,
      remaining: result.remaining,
      resetTime: result.resetTime,
    };
  }

  async peek(params: AlgorithmCheckParams<ITokenBucketStorage>): Promise<Omit<AlgorithmResult, 'allowed'>> {
    const { storage, key, limit, windowSeconds } = params;
    const capacity = limit;
    const refillRate = limit / windowSeconds;
    const result = await storage.tokenBucketPeek({ key, capacity, refillRate });
    return {
      currentCount: capacity - result.remaining,
      remaining: result.remaining,
      resetTime: result.resetTime,
    };
  }
}
