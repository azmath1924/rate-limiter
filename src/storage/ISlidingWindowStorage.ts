import { IBaseStorage } from './IBaseStorage';

export interface SlideAndCheckParams {
  key: string;
  limit: number;
  windowSeconds: number;
  // timestamp intentionally absent — storage implementations must source time
  // from the datastore (e.g. redis.call('TIME')) to avoid cross-instance clock skew.
}

export interface SlideAndCheckResult {
  allowed: boolean;
  currentCount: number;
  remaining: number;
  resetTime: number;
}

export interface SlidingWindowPeekParams {
  key: string;
  limit: number;
  windowSeconds: number;
  // timestamp intentionally absent — same reason as SlideAndCheckParams.
}

export interface SlidingWindowPeekResult {
  currentCount: number;
  remaining: number;
  resetTime: number;
}

export interface ISlidingWindowStorage extends IBaseStorage {
  slideAndCheck(params: SlideAndCheckParams): Promise<SlideAndCheckResult>;
  peek(params: SlidingWindowPeekParams): Promise<SlidingWindowPeekResult>;
}
