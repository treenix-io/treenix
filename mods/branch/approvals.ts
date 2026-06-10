// Merge-approval projection — files an ai.approval inbox entry for every
// branch sitting in status=review. The branch status is the source of truth
// (set by Branch.requestMerge); the inbox entry is a derived reaction, created
// here by the orchestrator watcher. Idempotent: one pending approval per branch.

import { makeNode } from '@treenx/core';
import type { Tree } from '@treenx/core/tree';

export const APPROVALS_ROOT = '/guardian/approvals';

export async function fileMergeApprovals(store: Tree, branchesRoot = '/branches'): Promise<number> {
  const { items: branches } = await store.getChildren(branchesRoot);
  const byPath = new Map(branches.filter(b => b.$type === 't.branch').map(b => [b.$path, b]));
  const inReview = [...byPath.values()].filter(b => b.status === 'review');

  const { items: approvals } = await store.getChildren(APPROVALS_ROOT);
  const pendingBranchCards = approvals.filter(
    a => a.$type === 'ai.approval' && a.status === 'pending' && typeof a.branchRef === 'string' && a.branchRef,
  );
  const pendingFor = new Set(pendingBranchCards.map(a => a.branchRef as string));

  // Symmetric projection: the branch resolved outside the card (human merged or
  // abandoned from the branch view) → settle the inbox entry too.
  for (const card of pendingBranchCards) {
    const b = byPath.get(card.branchRef as string);
    const settled = b?.status === 'merged' ? 'approved'
      : (b?.status === 'abandoned' || !b) ? 'denied'
      : null; // review → still pending; conflict → resolution still owed
    if (!settled) continue;
    await store.set({ ...card, status: settled, reason: b ? `branch ${b.status}` : 'branch removed', resolvedAt: Date.now() });
  }

  let filed = 0;
  for (const b of inReview) {
    if (pendingFor.has(b.$path)) continue;
    const id = `m-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await store.set(makeNode(`${APPROVALS_ROOT}/${id}`, 'ai.approval', {
      agentPath: typeof b.owner === 'string' ? b.owner : '',
      agentRole: 'branch-owner',
      tool: 'branch.merge',
      input: typeof b.title === 'string' ? b.title : b.$path,
      inputTruncated: false,
      status: 'pending' as const,
      reason: 'merge review',
      createdAt: Date.now(),
      resolvedAt: 0,
      branchRef: b.$path,
    }));
    filed++;
  }
  return filed;
}
