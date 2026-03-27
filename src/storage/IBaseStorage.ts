export interface IBaseStorage {
  reset(key: string): Promise<void>;
  healthCheck(): Promise<boolean>;
}
