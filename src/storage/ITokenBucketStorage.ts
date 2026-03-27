import { IBaseStorage } from './IBaseStorage';

export interface TokenBucketParams {
  key: string;
  capacity: number;
  refillRate: number;
}

export interface TokenBucketResult {
  allowed: boolean;
  remaining: number;
  resetTime: number;
}

export interface TokenBucketPeekResult {
  remaining: number;
  resetTime: number;
}

export interface ITokenBucketStorage extends IBaseStorage {
  tokenBucketConsume(params: TokenBucketParams): Promise<TokenBucketResult>;
  tokenBucketPeek(params: TokenBucketParams): Promise<TokenBucketPeekResult>;
}
