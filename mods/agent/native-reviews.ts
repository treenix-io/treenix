import type { WriteActionContext } from '@treenx/core/kernel/types';
import { approvalKey } from '#agent/native-guardian';
import { optionalPoolNode, poolChildren, type PoolConfig } from '#agent/native-pool';
import { requirePoolController } from '#agent/native-pool-run';
import type { NativeBranchState } from '#branch/native-types';
import { getComponent } from '@treenx/core';

/** Projects actual branch review and resolution into the approval cards used by the existing UI. */
export async function projectNativeReviews(
  this: PoolConfig,
  ctx: WriteActionContext,
): Promise<void> {
  await requirePoolController(ctx);
  for (const node of await poolChildren(ctx.read, this.branchesPath)) {
    if (node.$type !== 't.branch') continue;
    const branch = getComponent<NativeBranchState>(node, 't.branch')!;
    const operation = { kind: 'act', path: node.$path, action: 'merge', args: {} };
    const principal = branch.owner.startsWith('n:') ? branch.owner : `u:${branch.owner}`;
    const path = `${this.approvalsPath}/merge-${approvalKey(principal, operation)}`;
    const card = await optionalPoolNode(ctx.read, path);
    if (card === undefined) {
      if (branch.status !== 'review') continue;
      ctx.change.put({
        $path: path,
        $type: 'ai.approval',
        principal,
        operation,
        status: 'pending',
        createdAt: Date.now(),
        expiresAt: 0,
        agentPath: principal,
        agentRole: 'branch-owner',
        tool: 'branch.merge',
        input: branch.title,
        inputTruncated: false,
        branchRef: node.$path,
        reason: 'merge review',
        resolvedAt: 0,
        remember: '',
      });
    } else if (
      card.status === 'pending' &&
      (branch.status === 'merged' || branch.status === 'abandoned')
    ) {
      ctx.change.patch(path, {
        $set: {
          status: branch.status === 'merged' ? 'approved' : 'denied',
          reason: `branch ${branch.status}`,
          resolvedAt: Date.now(),
        },
      });
    }
  }
}
