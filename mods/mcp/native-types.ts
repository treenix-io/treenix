import type { ActRequest, CommitRequest, NodeInput, OpId } from '@treenx/core/kernel/types';

export interface NativeMcpServerConfig {
  readonly url: string;
  readonly systemPath: string;
  readonly branchPath?: string;
}

/** Client tool inputs use the native action, node and precondition contracts directly. */
export interface NativeMcpToolInputs {
  readonly get_node: { path: string };
  readonly list_children: { path: string };
  readonly execute: ActRequest;
  readonly deploy_prefab: { source: string; target: string; allowAbsolute?: boolean };
  readonly set_node: { node: NodeInput; expect?: CommitRequest['expect']; opId?: OpId };
  readonly remove_node: { path: string; expect?: CommitRequest['expect']; opId?: OpId };
  readonly describe_type: { type: string };
  readonly search_types: { query: string };
}

/** Explicit deployment coordinates preserve the authenticated Session authority. */
export interface NativeMcpCoordinates {
  readonly branchPath?: string;
}
