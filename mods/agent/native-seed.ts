import { A, R, W, type AclEntry, type NodeInput } from '@treenx/core/kernel/types';
import { nativeSeed } from '@treenx/core/mod/native-prefab';
import { agentSeed } from '#agent/seed-data';
import { nativeWorkerPath } from '#agent/native-pool-manifest';

/** Converts the prefab's declared legacy permission bits into native ACL entries. */
function acl(entries: readonly { g: string; p: number }[]): readonly AclEntry[] {
  return entries.map((entry) =>
    entry.p === 0
      ? { subject: { group: entry.g }, deny: R | W | A }
      : {
          subject: { group: entry.g },
          grant: (entry.p & 1 ? R : 0) | (entry.p & 2 ? W : 0) | (entry.p & 8 ? A : 0),
        },
  );
}

/** Preserves the existing office nodes and explicitly declares the native scheduler and its grants. */
export function nativeAgentSeed() {
  const service = '/agents/service';
  const worker = nativeWorkerPath('/agents/workers', '/agents/qa');
  const nodes: NodeInput[] = agentSeed.map(
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
    { $path: worker, $type: 'ai.worker', poolPath: service, agentPath: '/agents/qa' },
    {
      $path: service,
      $type: 'ai.pool-service',
      poolPath: '/agents',
      tasksPath: '/board/data',
      orgPath: '/org',
      workersPath: '/agents/workers',
      branchesPath: '/branches',
      approvalsPath: '/guardian/approvals',
      workspaceBase: '/board',
      readScope: ['/board', '/memory', '/org', '/sys/types', '/sys/mods'],
    },
    { $path: 'guardian/service', $type: 'ai.guardian' },
    { $path: '/sys/autostart/guardian', $type: 'ref', $ref: '/guardian/service' },
    { $path: 'branches', $type: 't.branches' },
  );
  return nativeSeed(
    'agent',
    nodes,
    [{ $path: '/sys/autostart', $type: 't.autostart' }],
    [
      { executor: service, target: '/', grant: R },
      { executor: service, target: '/agents', grant: R | W | A },
      { executor: service, target: '/board/data', grant: R | W },
      { executor: service, target: '/branches', grant: R | W | A },
      { executor: service, target: '/guardian/approvals', grant: R | W },
      { executor: worker, target: '/', grant: R },
      { executor: '/guardian/service', target: '/guardian/approvals', grant: R | W },
      { executor: '/guardian/service', target: '/guardian/service', grant: R },
      { executor: '/sys/autostart', target: '/sys/autostart', grant: R },
      { executor: '/sys/autostart', target: service, grant: R },
      { executor: '/sys/autostart', target: '/guardian/service', grant: R },
    ],
  );
}
