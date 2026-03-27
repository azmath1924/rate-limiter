import { IBaseStorage } from '../../storage/IBaseStorage';

export interface AlgorithmCheckParams<S extends IBaseStorage> {
  storage: S;
  key: string;
  limit: number;
  windowSeconds: number;
}

export interface AlgorithmResult {
  allowed: boolean;
  currentCount: number;
  remaining: number;
  resetTime: number;
}

export interface IAlgorithm<S extends IBaseStorage> {
  check(params: AlgorithmCheckParams<S>): Promise<AlgorithmResult>;
  peek(params: AlgorithmCheckParams<S>): Promise<Omit<AlgorithmResult, 'allowed'>>;
}
