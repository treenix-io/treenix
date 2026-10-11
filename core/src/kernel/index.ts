import { createInstance as constructInstance } from './instance'
import type { CreateInstance } from './types'

export * from './types'
export { collectModule, registerKernel, registerKernelAction, registerKernelSeeds } from './manifest'
export { getActionContext } from './current-action'

export const createInstance: CreateInstance = constructInstance
