import { declareClientType } from '@treenx/core/comp/client-declaration';
import { declareOpenModule } from '@treenx/core/kernel/module-declaration';
import { registerType } from '@treenx/core/comp';
import { KernelError } from '@treenx/core/errors';
import type { NativeBranchConflict, NativeBranchDiff, NativeBranchState } from './native-types';

export type BranchStatus = NativeBranchState['status'];
export type DiffEntry = NativeBranchDiff;
export type ConflictEntry = NativeBranchConflict;

/** Typed calls from the existing UI are implemented by the native container owner. */
export interface Branches {
  create(data?: { title?: string; owner?: string; ownerPath?: string; base?: string }): Promise<{ path: string }>;
}

/** Native actions use the UI's data class without adding executable methods to snapshots. */
export interface Branch {
  /** @read @description List the native future's changes against live. */
  diff(): Promise<{ entries: NativeBranchDiff[] }>;
  merge(): Promise<{ merged: number; applied: string[]; conflicts: NativeBranchConflict[]; status?: string }>;
}

/** Container at /branches — branches are created through it, never by hand. */
export class Branches {
}

/** A write-isolated future. Work happens under `<path>/tree`; every write is
 *  captured under `<path>/delta` and the live tree stays untouched until merge. */
export class Branch {
  base = '/';
  owner = '';
  status: BranchStatus = 'open';
  title = '';
  createdAt = 0;
  mergedAt = 0;
  conflicts: ConflictEntry[] = [];

  /** @description Close the branch without merging. Delta stays as the record. */
  abandon() {
    if (this.status === 'merged') throw new KernelError('CONFLICT', 'cannot abandon a merged branch');
    this.status = 'abandoned';
  }

  /** @description Mark the branch ready for human review and merge.
   *  The native orchestrator owns publication to the approval inbox. */
  requestMerge(data?: { note?: string }) {
    if (this.status !== 'open') {
      throw new KernelError('CONFLICT', `cannot request merge in status "${this.status}"`);
    }
    if (data?.note) this.title = this.title ? `${this.title} — ${data.note}` : data.note;
    this.status = 'review';
    return { status: 'review' as const };
  }
}

registerType('t.branches', Branches);
registerType('t.branch', Branch);

// The client class identifies the native mount declaration.
export class MountBranch {}
registerType('t.mount.branch', MountBranch);

export const clientModules = [declareOpenModule('@treenx/mods/branch/types', [], [
  declareClientType('t.branches', Branches),
  declareClientType('t.branch', Branch),
  declareClientType('t.mount.branch', MountBranch),
])];
