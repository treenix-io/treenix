// Treenix Module System — type definitions

export type ModState = 'discovered' | 'loading' | 'loaded' | 'failed' | 'disabled';

export interface LoadedMod {
  name: string;
  state: ModState;
  error?: Error;
  loadedAt?: number;
  loadDurationMs?: number;
}
