import type { NodeData } from '#core';
import type { NodeInput } from '#kernel/types';

/** Private contract for the retained lab DSL; native applications use Session and Reader. */
export interface Tree {
  get(path: string): Promise<NodeData | undefined>;
  getChildren(path: string, options?: { query?: Record<string, unknown> }): Promise<{ items: NodeData[] }>;
  set(node: NodeInput): Promise<unknown>;
  execute?(path: string, action: string, data?: unknown, options?: { type?: string; key?: string }): Promise<unknown>;
}
