import { createInstance as constructInstance } from './instance';
import type { CreateInstance } from './types';

export * from './types';
export { instantiateModule } from './manifest';
export { getActionContext, getActionLifetime } from './current-action';

export const createInstance: CreateInstance = constructInstance;
