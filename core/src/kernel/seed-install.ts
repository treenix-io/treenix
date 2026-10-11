import { createHash } from 'node:crypto';
import { getComponent } from '#core';
import { KernelError } from '#errors';
import { A, type Node, type NodeInput, type OpId, type Session } from '#kernel/types';
import type { CapturedSeedNode, NativePrefabSource } from '#mod/native-prefab';
import { assertPrefabPath, prefabInput, resolvePrefabPath } from '#mod/prefab-path';
import { stableJson } from '#util/stable-json';
import type { CollectedModule } from '#kernel/manifest';

export interface NativeSeedPrefab {
  readonly source: NodeInput & {
    readonly $type: 't.prefab';
    readonly mod: string;
    readonly name: string;
    readonly nodes: readonly CapturedSeedNode[];
  };
  readonly target: string;
  readonly allowAbsolute?: boolean;
  /** Legacy setup belongs to its old runtime and cannot receive a native Tree substitute. */
  readonly setup?: unknown;
}

export interface NativeSeedPlan {
  /** Explicit native module/catalog parents; no ambient discovery or manufactured defaults. */
  readonly sources: readonly NodeInput[];
  readonly prefabs: readonly NativeSeedPrefab[];
  /** Owned by the caller from the actual current intake; retain it unchanged when retrying. */
  readonly opId: OpId;
}

export type NativeSeedDefinition = Omit<NativeSeedPlan, 'opId'>;

/** Select the root's named seeds from native module declarations before opening storage. */
export function selectNativeSeeds(modules: readonly CollectedModule[], names: readonly string[]): NativeSeedDefinition {
  const sources = new Map<string, NodeInput>();
  const prefabs: NativeSeedPrefab[] = [];

  for (const name of names) {
    let found = false;
    for (const module of modules) {
      if (module.seeds === undefined) continue;
      const selected = module.seeds.prefabs.filter(prefab => prefab.source.mod === name);
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

  /** Each request contains one put; the kernel's saved read/write budgets remain authoritative. */
  async function put(node: NodeInput, owner: string, source?: Node): Promise<void> {
    if (!(await absent(session, node.$path))) {
      skipped.push(node.$path);
      return;
    }
    await session.commit({
      opId: childKey(plan.opId, owner, node.$path),
      changes: [{ op: 'put', node }],
      expect: {
        absent: [node.$path],
        nodes: source === undefined ? [admin] : [admin, { path: source.$path, rev: source.$rev }],
      },
    }).outcome;
    if (await absent(session, node.$path))
      throw new KernelError('CONFLICT', 'Replayed seed outcome no longer has its installed target');
    installed.push(node.$path);
  }

  for (const source of plan.sources) await put(source, 'catalog');
  for (const prefab of plan.prefabs) {
    const source: NativePrefabSource = {
      ...prefab.source,
      nodes: prefab.source.nodes.map((node) => prefabInput(node, node.$path)),
    };
    await put(source, 'source');
  }

  for (const prefab of plan.prefabs) {
    const accepted = await readNode(session, prefab.source.$path);
    const source = getComponent<NativePrefabSource>(accepted, 't.prefab');
    if (source === undefined)
      throw new KernelError('INVALID', 'Accepted seed source has another type');
    const owner = stableJson({ id: accepted.$id, rev: accepted.$rev });
    for (const node of source.nodes) {
      const path = resolvePrefabPath(node.$path, prefab.target, prefab.allowAbsolute);
      await put(prefabInput(node, path), owner, accepted);
    }
  }
  return { installed, skipped };
}
