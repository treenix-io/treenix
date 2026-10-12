import { A, R, W, type AclEntry, type NodeInput } from '@treenx/core/kernel/types';
import { nativeSeed } from '#prefab/seed';
import type { AgentSeedNode } from '#agent/seed-data';
import type { PoolConfig } from '#agent/native-pool';
import { nativeWorkerPath } from '#agent/native-pool-manifest';

/** Converts the prefab's declared legacy permission bits into native ACL entries. */
function acl(entries: readonly { g: string; p: number }[]): readonly AclEntry[] {
  return entries.map((entry) =>
    entry.p === 0
      ? { subject: { group: entry.g }, deny: R | W | A }
      : {
          subject: { group: entry.g },
          grant:
            (entry.p & R ? R : 0) |
            (entry.p & W ? W : 0) |
            (entry.p & A ? A : 0),
        },
  );
}

/** Preserves the existing office nodes and explicitly declares the native scheduler and its grants. */
export function nativeOfficeSeed(
  mod: string,
  seed: readonly AgentSeedNode[],
  config: Pick<PoolConfig, 'orgPath' | 'workspaceBase' | 'readScope'>,
  agentPaths: readonly string[],
) {
  const service = '/agents/service';
  const workers = agentPaths.map((agentPath) => ({
    $path: nativeWorkerPath('/agents/workers', agentPath),
    $type: 'ai.worker',
    poolPath: service,
    agentPath,
  }));
  const nodes: NodeInput[] = seed.map(
    ({ $acl, ...node }): NodeInput => ({
      ...node,
      ...($acl === undefined ? {} : { $acl: acl($acl) }),
      ...(node.$path === 'agents' ? { servicePath: service } : {}),
      ...(node.$path === 'agents/mcp' ? { model: '', systemPrompt: '' } : {}),
      ...(node.$path === 'guardian/approvals'
        ? { source: { $type: 'ref', $ref: '/guardian/approvals' } }
        : {}),
      ...(node.$path === '/sys/autostart/agents' ? { $ref: service } : {}),
    }),
  );
  nodes.push(
    { $path: 'agents/workers', $type: 't.dir' },
    ...workers,
    {
      $path: service,
      $type: 'ai.pool-service',
      poolPath: '/agents',
      tasksPath: '/board/data',
      orgPath: config.orgPath,
      workersPath: '/agents/workers',
      branchesPath: '/branches',
      approvalsPath: '/guardian/approvals',
      workspaceBase: config.workspaceBase,
      readScope: config.readScope,
    },
    { $path: 'guardian/service', $type: 'ai.guardian' },
    { $path: '/sys/autostart/guardian', $type: 'ref', $ref: '/guardian/service' },
    { $path: 'branches', $type: 't.branches' },
  );
  return nativeSeed(
    mod,
    nodes,
    [{ $path: '/sys/autostart', $type: 't.autostart' }],
    [
      { executor: service, target: '/', grant: R },
      { executor: service, target: '/agents', grant: R | W | A },
      { executor: service, target: '/board/data', grant: R | W },
      { executor: service, target: '/branches', grant: R | W | A },
      { executor: service, target: '/guardian/approvals', grant: R | W },
      ...workers.map((worker) => ({ executor: worker.$path, target: '/', grant: R })),
      ...agentPaths.map((agentPath) => ({
        executor: service,
        target: agentPath,
        grant: R | W | A,
      })),
      { executor: '/guardian/service', target: '/guardian/approvals', grant: R | W },
      { executor: '/guardian/service', target: '/guardian/service', grant: R },
      { executor: '/sys/autostart', target: '/sys/autostart', grant: R },
      { executor: '/sys/autostart', target: service, grant: R },
      { executor: '/sys/autostart', target: '/guardian/service', grant: R },
    ],
  );
}
