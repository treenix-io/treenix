// Optimistic Rebase — confirmed + pending + replay
// Applies server patches to pre-optimistic state, replays remaining pending ops.
// Zero React deps, pure logic.

import { getComponent, type NodeData } from '@treenx/core';
import type { Class } from '@treenx/core/comp';
import fjp from 'fast-json-patch';
import type { Operation } from 'fast-json-patch';

const { applyPatch } = fjp;
import * as cache from './cache';

interface PendingOp {
  cls: Class<any>;
  key?: string;
  handler: Function;
  data: unknown;
}

interface RebaseState {
  confirmed: NodeData;
  pending: PendingOp[];
}

const state = new Map<string, RebaseState>();

/** Replay all pending ops on confirmed and put result in cache */
function replayAndPut(path: string, rs: RebaseState) {
  const draft = structuredClone(rs.confirmed);
  for (const op of rs.pending) {
    try {
      const comp = getComponent(draft, op.cls, op.key);
      if (comp) op.handler({ comp, node: draft }, op.data);
    } catch { /* failed replay — skip */ }
  }
  cache.put(draft);
}

function cleanup(path: string, rs: RebaseState) {
  cache.put(rs.confirmed);
  state.delete(path);
}

/** Push an optimistic action — snapshot confirmed on first call, replay all pending */
export function pushOptimistic<T extends object>(
  path: string, cls: Class<T>, key: string | undefined,
  handler: Function, data: unknown,
): void {
  const cached = cache.get(path);
  if (!cached) return;

  let rs = state.get(path);
  if (!rs) {
    rs = { confirmed: structuredClone(cached), pending: [] };
    state.set(path, rs);
  }
  rs.pending.push({ cls, key, handler, data });
  replayAndPut(path, rs);
}

/** Apply server patch to confirmed state. Returns true if rebase handled it. */
export function applyServerPatch(path: string, patches: Operation[]): boolean {
  const rs = state.get(path);
  if (!rs) return false;

  applyPatch(rs.confirmed, patches);
  rs.pending.shift();

  if (rs.pending.length === 0) {
    cleanup(path, rs);
  } else {
    replayAndPut(path, rs);
  }
  return true;
}

/** Apply server set (full node) to confirmed state. Returns true if rebase handled it. */
export function applyServerSet(path: string, node: NodeData): boolean {
  const rs = state.get(path);
  if (!rs) return false;

  rs.confirmed = node;
  rs.pending.shift();

  if (rs.pending.length === 0) {
    cleanup(path, rs);
  } else {
    replayAndPut(path, rs);
  }
  return true;
}

/** Rollback last pending op (action failed on server) */
export function rollback(path: string): void {
  const rs = state.get(path);
  if (!rs) return;

  rs.pending.pop();

  if (rs.pending.length === 0) {
    cleanup(path, rs);
  } else {
    replayAndPut(path, rs);
  }
}

/** Check if path has rebase state (for testing) */
export function hasPending(path: string): boolean {
  return state.has(path);
}

/** Clear all rebase state (for testing) */
export function clear(): void {
  state.clear();
}
