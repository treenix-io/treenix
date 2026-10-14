import type { NodeId, NodeInput, Rev, StoreBindingBody } from '@treenx/core/kernel/types';

export interface NativeBranchWrapper {
  readonly baseId: NodeId | null;
  readonly baseRev: Rev | null;
}
export interface NativeBranchDelta extends NativeBranchWrapper {
  readonly node: StoreBindingBody;
}
export interface NativeBranchConflict {
  readonly path: string;
  readonly expectedRev: Rev | null;
  readonly actualRev: Rev | null;
}
export interface NativeBranchState {
  readonly base: string;
  readonly owner: string;
  readonly status: 'open' | 'review' | 'merged' | 'conflict' | 'abandoned';
  readonly title: string;
  readonly createdAt: number;
  readonly mergedAt: number;
  readonly conflicts: readonly NativeBranchConflict[];
}
export interface NativeBranchDiff {
  readonly path: string;
  readonly op: 'create' | 'set' | 'remove' | 'noop';
  readonly baseRev: Rev | null;
  readonly node?: NodeInput;
}
