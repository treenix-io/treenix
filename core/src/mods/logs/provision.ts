import { KernelError } from '#errors';
import { getComponent } from '#core';
import {
  A,
  R,
  W,
  type ChangeMember,
  type Node,
  type NodeCopy,
  type OpId,
  type Session,
} from '#kernel/types';

async function read(session: Session, path: string): Promise<Node | undefined> {
  let copy: NodeCopy;
  try {
    copy = (await session.read({ node: path })).copies[0];
  } catch (error) {
    if (error instanceof KernelError && error.code === 'NOT_FOUND') return undefined;
    throw error;
  }
  if ('error' in copy) throw copy.error;
  if ((copy.bits & A) === 0)
    throw new KernelError('FORBIDDEN', 'Log provisioning requires administrator admission');
  return copy.node;
}

/** Pin real service identities before admitting their Fs mount and autostart through normal admin commits. */
export async function provisionLogs(
  session: Session,
  directory: string,
  opId: () => OpId,
): Promise<void> {
  if (directory.length === 0)
    throw new KernelError('INVALID', 'Persistent logs require a directory capability name');
  const paths = ['/sys/logs', '/sys/autostart'],
    types = ['t.logs', 't.autostart'];
  const nodes = await Promise.all(paths.map((path) => read(session, path)));
  const create: ChangeMember[] = [];
  for (let i = 0; i < paths.length; i++) {
    if (nodes[i] === undefined)
      create.push({
        op: 'put',
        node: {
          $path: paths[i],
          $type: types[i],
          $acl: [{ subject: { group: 'admins' }, grant: R | W | A }],
        },
      });
    else if (nodes[i]!.$type !== types[i])
      throw new KernelError('CONFLICT', 'Log provisioning address has another owner');
  }
  if (create.length !== 0)
    await session.commit({
      opId: opId(),
      changes: create,
      expect: { absent: paths.filter((_, i) => nodes[i] === undefined) },
    }).outcome;
  let logs = (await read(session, paths[0]))!,
    autostart = (await read(session, paths[1]))!;
  const changes: ChangeMember[] = [];
  for (const [node, grants] of [
    [
      logs,
      [
        { principal: `n:${logs.$id}`, bits: R | W },
        { principal: `n:${autostart.$id}`, bits: R },
      ],
    ],
    [autostart, [{ principal: `n:${autostart.$id}`, bits: R }]],
  ] satisfies readonly (readonly [Node, readonly { principal: string; bits: number }[]])[]) {
    const acl = [...(node.$acl ?? [])];
    let changed = false;
    for (const { principal, bits } of grants) {
      let existing = 0;
      for (const entry of acl)
        if ('group' in entry.subject && entry.subject.group === principal) {
          if ('deny' in entry && (entry.deny & bits) !== 0)
            throw new KernelError('FORBIDDEN', 'Log capability has an explicit deny');
          if ('grant' in entry) existing |= entry.grant;
        }
      if ((existing & bits) !== bits) {
        acl.push({ subject: { group: principal }, grant: bits });
        changed = true;
      }
    }
    if (changed) changes.push({ op: 'patch', path: node.$path, ops: { $set: { $acl: acl } } });
  }
  if (changes.length !== 0)
    await session.commit({
      opId: opId(),
      changes: [...changes],
      expect: { nodes: [logs, autostart].map((node) => ({ path: node.$path, rev: node.$rev })) },
    }).outcome;
  changes.length = 0;
  logs = (await read(session, paths[0]))!;
  autostart = (await read(session, paths[1]))!;
  const mount = getComponent<{ directory: string; pattern: string; external?: string }>(
    logs,
    't.mount.fs',
  );
  if (mount === undefined && logs['#store'] !== undefined)
    throw new KernelError('CONFLICT', 'Log Store component address is occupied');
  if (mount === undefined)
    changes.push({
      op: 'patch',
      path: logs.$path,
      ops: {
        $set: { '#store': { $type: 't.mount.fs', directory, pattern: '', external: 'none' } },
      },
    });
  else if (mount.directory !== directory || mount.pattern !== '' || mount.external !== 'none')
    throw new KernelError('CONFLICT', 'Persistent logs have another Store declaration');
  if (changes.length !== 0)
    await session.commit({
      opId: opId(),
      changes: [...changes],
      expect: { nodes: [{ path: logs.$path, rev: logs.$rev }] },
    }).outcome;
  changes.length = 0;
  // Activate the actual data owner before publishing the reference that starts its service Session.
  await session.read({ children: logs.$path, window: { limit: 1 } });
  logs = (await read(session, paths[0]))!;
  const referencePath = '/sys/autostart/logs',
    reference = await read(session, referencePath);
  if (reference === undefined)
    changes.push({ op: 'put', node: { $path: referencePath, $type: 't.ref', $ref: logs.$path } });
  else if (reference.$type !== 't.ref' || reference.$ref !== logs.$path)
    throw new KernelError('CONFLICT', 'Log autostart reference has another target');
  if (changes.length !== 0)
    await session.commit({
      opId: opId(),
      changes,
      expect: {
        nodes: [logs, autostart, ...(reference === undefined ? [] : [reference])].map((node) => ({
          path: node.$path,
          rev: node.$rev,
        })),
        absent: reference === undefined ? [referencePath] : [],
      },
    }).outcome;
}
