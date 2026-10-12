import { createHash } from 'node:crypto';
import { getComponent } from '@treenx/core';
import { KernelError } from '@treenx/core/errors';
import {
  A,
  R,
  W,
  type Node,
  type NodeInput,
  type OpId,
  type Session,
  type ChangeMember,
} from '@treenx/core/kernel/types';
import type {
  NativePrefabSource,
  NativeSeedDefinition,
  NativeSeedPlan,
  NativeSeedPrefab,
} from '@treenx/core/mod/native-prefab';
import { assertPrefabPath, prefabInput, resolvePrefabPath } from '@treenx/core/mod/prefab-path';
import { stableJson } from '@treenx/core/util/stable-json';
import { prefabCopy, sourceMaps, sourcePath, sourceRecords } from '#prefab/source';
import { readNode as readPrefabNode, SOURCE_TYPE } from '#prefab/data';
import { childMarks, optionalNode } from '#prefab/structure';

export type {
  NativeSeedDefinition,
  NativeSeedPlan,
  NativeSeedPrefab,
} from '@treenx/core/mod/native-prefab';

interface MaterializedPrefab extends NativePrefabSource {
  readonly materialized?: boolean;
}

/** Select the root's named seeds from native module declarations before opening storage. */
export function selectNativeSeeds(
  modules: readonly { readonly seeds?: NativeSeedDefinition }[],
  names: readonly string[],
): NativeSeedDefinition {
  const sources = new Map<string, NodeInput>();
  const prefabs: NativeSeedPrefab[] = [];

  for (const name of names) {
    let found = false;
    for (const module of modules) {
      if (module.seeds === undefined) continue;
      const selected = module.seeds.prefabs.filter((prefab) => prefab.source.mod === name);
      if (selected.length === 0) continue;
      if (found) throw new KernelError('CONFLICT', `Seed has multiple native owners: ${name}`);
      found = true;
      prefabs.push(...selected);

      for (const source of module.seeds.sources) {
        const previous = sources.get(source.$path);
        if (previous !== undefined && stableJson(previous) !== stableJson(source))
          throw new KernelError('CONFLICT', `Conflicting seed source: ${source.$path}`);
        sources.set(source.$path, source);
      }
    }
    if (!found) throw new KernelError('UNAVAILABLE', `Seed requires a native declaration: ${name}`);
  }

  return { sources: [...sources.values()], prefabs };
}

export interface NativeSeedResult {
  readonly installed: readonly string[];
  readonly skipped: readonly string[];
}

/** Read an accepted projection; malformed or refused copies remain loud failures. */
async function readNode(session: Session, path: string): Promise<Node> {
  const copy = (await session.read({ node: path })).copies[0];
  if ('error' in copy) throw new KernelError(copy.error.code, copy.error.message);
  return copy.node;
}

/** Absence is the only read refusal that copy-if-absent can consume. */
async function absent(session: Session, path: string): Promise<boolean> {
  try {
    await readNode(session, path);
    return false;
  } catch (error) {
    if (error instanceof KernelError && error.code === 'NOT_FOUND') return true;
    throw error;
  }
}

/** Bind a canonical child request to the caller's actual installation operation. */
function childKey(operation: OpId, owner: string, path: string): OpId {
  const digest = createHash('sha256').update(stableJson({ owner, path })).digest('hex');
  return { epoch: operation.epoch, time: operation.time, nonce: `${operation.nonce}:${digest}` };
}

/** Refuse unsupported setup and malformed source paths before seed writes or boot resource acquisition. */
export function assertNativeSeeds(plan: NativeSeedDefinition): void {
  for (const prefab of plan.prefabs) {
    if (prefab.setup !== undefined)
      throw new KernelError('UNAVAILABLE', 'Legacy prefab setup requires its retiring runtime');
    const source = prefab.source;
    if (source.$path !== `/sys/mods/${source.mod}/prefabs/${source.name}`)
      throw new KernelError('INVALID', 'Prefab source must belong to its declared module and name');
    assertPrefabPath(source.$path);
    assertPrefabPath(prefab.target);
    for (const node of source.nodes)
      resolvePrefabPath(node.$path, prefab.target, prefab.allowAbsolute);
    for (const grant of source.grants ?? []) {
      resolvePrefabPath(grant.executor, prefab.target, prefab.allowAbsolute);
      resolvePrefabPath(grant.target, prefab.target, prefab.allowAbsolute);
      if (!Number.isInteger(grant.grant) || grant.grant <= 0 || (grant.grant & ~(R | W | A)) !== 0)
        throw new KernelError('INVALID', 'Invalid native seed grant');
    }
  }
  for (const source of plan.sources) assertPrefabPath(source.$path);
}

/** Install native sources first, then copy accepted prefab data through bounded caller-owned requests. */
export async function installNativeSeeds(
  session: Session,
  plan: NativeSeedPlan,
): Promise<NativeSeedResult> {
  assertNativeSeeds(plan);

  const rootCopy = (await session.read({ node: '/' })).copies[0];
  if ('error' in rootCopy) throw new KernelError(rootCopy.error.code, rootCopy.error.message);
  if ((rootCopy.bits & A) !== A)
    throw new KernelError('FORBIDDEN', 'Seed installation requires root administration');
  const admin = { path: '/', rev: rootCopy.node.$rev };
  const installed: string[] = [],
    skipped: string[] = [];

  /** A copy and its parent mark share one bounded commit; raw source records remain single puts. */
  async function put(node: NodeInput, owner: string, source?: Node): Promise<void> {
    if (!(await absent(session, node.$path))) {
      skipped.push(node.$path);
      return;
    }
    const separator = node.$path.lastIndexOf('/');
    const parent =
      source?.$type === SOURCE_TYPE && node.$path !== '/'
        ? await optionalNode(session, node.$path.slice(0, separator) || '/')
        : undefined;
    const name = node.$path.slice(separator + 1);
    const mark = parent?.$prefabChildren?.[name];
    if (mark !== undefined) {
      if (mark.removed !== true && parent !== undefined) {
        await session.commit({
          opId: childKey(plan.opId, owner, `removed:${node.$path}`),
          expect: {
            absent: [node.$path],
            nodes: [admin, { path: parent.$path, rev: parent.$rev }],
          },
          changes: [
            {
              op: 'patch',
              path: parent.$path,
              ops: {
                $set: {
                  $prefabChildren: childMarks(parent, name, mark.src, true),
                },
              },
            },
          ],
        }).outcome;
        if (parent.$path === '/') admin.rev = (await readNode(session, '/')).$rev;
      }
      skipped.push(node.$path);
      return;
    }
    const changes: ChangeMember[] = [{ op: 'put', node }];
    const pins = new Map([[admin.path, admin.rev]]);
    if (source !== undefined) pins.set(source.$path, source.$rev);
    if (parent !== undefined && source !== undefined) {
      changes.push({
        op: 'patch',
        path: parent.$path,
        ops: {
          $set: {
            $prefabChildren: childMarks(parent, name, source.$path),
          },
        },
      });
      pins.set(parent.$path, parent.$rev);
    }
    await session.commit({
      opId: childKey(plan.opId, owner, node.$path),
      changes,
      expect: {
        absent: [node.$path],
        nodes: [...pins].map(([path, rev]) => ({ path, rev })),
      },
    }).outcome;
    if (parent?.$path === '/') admin.rev = (await readNode(session, '/')).$rev;
    if (await absent(session, node.$path))
      throw new KernelError('CONFLICT', 'Replayed seed outcome no longer has its installed target');
    installed.push(node.$path);
  }

  for (const source of plan.sources) await put(source, 'catalog');
  const activation: { node: NodeInput; owner: string; source: Node }[] = [];
  const acceptedSeeds: { prefab: NativeSeedPrefab; node: Node; source: NativePrefabSource }[] = [];
  for (const prefab of plan.prefabs) {
    const source: NativePrefabSource = {
      ...prefab.source,
      nodes: prefab.source.nodes.map((node) => prefabInput(node, node.$path)),
    };
    await put(source, 'source');
  }

  for (const prefab of plan.prefabs) {
    let accepted = await readNode(session, prefab.source.$path);
    const source = getComponent<MaterializedPrefab>(accepted, 't.prefab');
    if (source === undefined)
      throw new KernelError('INVALID', 'Accepted seed source has another type');
    const owner = stableJson({ id: accepted.$id, rev: accepted.$rev });
    acceptedSeeds.push({ prefab, node: accepted, source });
    if (source.materialized !== true) {
      for (const record of sourceRecords(accepted.$path, source.nodes))
        await put(record, owner, accepted);
      await session.commit({
        opId: childKey(plan.opId, owner, 'materialized'),
        expect: { nodes: [admin, { path: accepted.$path, rev: accepted.$rev }] },
        changes: [{ op: 'patch', path: accepted.$path, ops: { $set: { materialized: true } } }],
      }).outcome;
      accepted = await readNode(session, accepted.$path);
      acceptedSeeds[acceptedSeeds.length - 1] = { prefab, node: accepted, source };
    }

    const maps = sourceMaps(accepted.$path, prefab.target);
    for (const node of source.nodes) {
      const path = resolvePrefabPath(node.$path, prefab.target, prefab.allowAbsolute);
      const template = await readPrefabNode(session, sourcePath(accepted.$path, node.$path));
      const input = prefabCopy(template, path, {
        sourceRoot: `${accepted.$path}/source/relative`,
        targetRoot: prefab.target,
        maps,
        catalog: accepted.$path,
      });
      if (path.startsWith('/sys/autostart/') && (input.$type === 'ref' || input.$type === 't.ref'))
        activation.push({ node: input, owner, source: template });
      else await put(input, owner, template);
    }
  }

  for (const { prefab, node: sourceNode, source } of acceptedSeeds) {
    for (const grant of source.grants ?? []) {
      const executor = await readNode(
        session,
        resolvePrefabPath(grant.executor, prefab.target, prefab.allowAbsolute),
      );
      const target = await readNode(
        session,
        resolvePrefabPath(grant.target, prefab.target, prefab.allowAbsolute),
      );
      const principal = `n:${executor.$id}`;
      const acl = target.$acl ?? [];
      const previous = acl.find(
        (entry) =>
          'group' in entry.subject && entry.subject.group === principal && 'grant' in entry,
      );
      const bits = previous !== undefined && 'grant' in previous ? previous.grant : 0;
      if ((bits & grant.grant) === grant.grant) continue;
      const subject = { group: principal };
      const updated =
        previous === undefined
          ? [...acl, { subject, grant: grant.grant }]
          : acl.map((entry) =>
              entry === previous ? { ...entry, grant: bits | grant.grant } : entry,
            );
      const pins = new Map([sourceNode, executor, target].map((node) => [node.$path, node.$rev]));
      pins.set(admin.path, admin.rev);
      await session.commit({
        opId: childKey(
          plan.opId,
          stableJson({ source: sourceNode.$id, executor: executor.$id }),
          target.$path,
        ),
        expect: { nodes: [...pins].map(([path, rev]) => ({ path, rev })) },
        changes: [{ op: 'patch', path: target.$path, ops: { $set: { $acl: updated } } }],
      }).outcome;
      // A declared root grant advances our own administrator pin before later seed steps.
      if (target.$path === admin.path) admin.rev = (await readNode(session, admin.path)).$rev;
    }
  }
  for (const entry of activation) await put(entry.node, entry.owner, entry.source);
  return { installed, skipped };
}
