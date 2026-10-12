import { getComponent } from '@treenx/core';
import { KernelError } from '@treenx/core/errors';
import type { Node, NodeInput, Reader } from '@treenx/core/kernel/types';
import type { NativePrefabSource } from '@treenx/core/mod/native-prefab';

export type PrefabCatalog = NativePrefabSource & { readonly materialized?: boolean };

export interface PrefabState {
  readonly src: string;
  readonly base: Readonly<Record<string, unknown>>;
  readonly sourceRoot: string;
  readonly targetRoot: string;
  readonly maps?: readonly ReferenceMap[];
  readonly catalog?: string;
}

export interface ReferenceMap {
  readonly from: string;
  readonly to: string;
  readonly exact?: boolean;
}

export const SOURCE_TYPE = 't.prefab.source';

export type PrefabChildren = Readonly<
  Record<string, { readonly src: string; readonly removed?: true }>
>;

export type PrefabInput = NodeInput & {
  readonly $prefab?: PrefabState;
  readonly $prefabChildren?: PrefabChildren;
};

export interface PrefabNode extends Node {
  readonly $prefab?: PrefabState;
  readonly $prefabChildren?: PrefabChildren;
}

/** A source record holds inert node input, so storing a template never starts a mount or service. */
export function sourceBody(node: PrefabNode): PrefabNode | PrefabInput {
  if (node.$type !== SOURCE_TYPE) return node;
  const source = getComponent<{ readonly body: PrefabInput }>(node, SOURCE_TYPE);
  if (source === undefined) throw new KernelError('INVALID', 'Prefab source record is missing');
  return source.body;
}

/** Read through the action's caller rights and retain the source revision as a precondition. */
export async function readNode(read: Reader, path: string): Promise<PrefabNode> {
  const copy = (await read.read({ node: path })).copies[0];
  if ('error' in copy) throw new KernelError(copy.error.code, copy.error.message);
  return copy.node;
}

/** Identity and provenance belong to the copy; they are never propagated as data. */
export function fields(node: Node | NodeInput): Record<string, unknown> {
  const { $path, $id, $rev, $type, $v, $refId, $prefab, $prefabChildren, ...data } = node;
  return data;
}

/** Keep references outside the instance unchanged and map the copied root exactly. */
function translatePath(path: string, maps: readonly ReferenceMap[]): string {
  for (const { from, to, exact } of maps) {
    if (path === from) return to;
    if (exact) continue;
    const prefix = from === '/' ? '/' : `${from}/`;
    if (!path.startsWith(prefix)) continue;
    const suffix = path.slice(prefix.length);
    return to === '/' ? `/${suffix}` : `${to}/${suffix}`;
  }
  return path;
}

/** Collect reference targets without treating ordinary string fields as addresses. */
export function referencePaths(value: unknown): ReadonlySet<string> {
  const paths = new Set<string>();
  function visit(item: unknown): void {
    if (item === null || typeof item !== 'object') return;
    const reference: unknown = Reflect.get(item, '$ref');
    if (typeof reference === 'string') paths.add(reference);
    for (const nested of Object.values(item)) visit(nested);
  }
  visit(value);
  return paths;
}

/** Translate only references inside the copied subtree, including references in named components. */
export function translate(value: unknown, maps: readonly ReferenceMap[]): unknown {
  if (Array.isArray(value)) return value.map((item) => translate(item, maps));
  if (value === null || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  const reference: unknown = Reflect.get(value, '$ref');
  const mapped = typeof reference === 'string' && translatePath(reference, maps) !== reference;
  for (const [name, item] of Object.entries(value)) {
    if (mapped && name === '$refId') continue;
    result[name] =
      mapped && name === '$ref' ? translatePath(reference, maps) : translate(item, maps);
  }
  return result;
}

/** Translate node fields without changing their names or retaining copied reference identities. */
export function translatedFields(
  node: Node | NodeInput,
  from: string,
  to: string,
  mapping?: readonly ReferenceMap[],
): Record<string, unknown> {
  const maps = mapping ?? [{ from, to }];
  const result: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(fields(node))) result[name] = translate(value, maps);
  const reference = node.$ref;
  if (typeof reference === 'string') {
    result.$ref = translatePath(reference, maps);
  }
  return result;
}

/** Reject cycles before changing the instance, including chains of variant instances. */
export async function assertChain(read: Reader, source: PrefabNode, target: string): Promise<void> {
  const seen = new Set([target]);
  let node = source;
  for (;;) {
    if (seen.has(node.$path)) throw new KernelError('INVALID', 'Prefab chain contains a cycle');
    seen.add(node.$path);
    const state = sourceBody(node).$prefab;
    if (state === undefined) return;
    node = await readNode(read, state.src);
  }
}
