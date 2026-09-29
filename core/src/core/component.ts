// ── ACL ──

export type GroupPerm = { g: string; p: number };
export const R = 1,
  W = 2,
  A = 4,
  S = 8;

// TODO: K extends `$${infer N}` ? never : K
// TODO: fix ComponentData and NodeData types. it should be generic types of its contents
export type ComponentData<T = Record<string, unknown>> = T & {
  $type: string;
  $acl?: GroupPerm[];
  /** Schema version stamped by migrations (tree/migration.ts). Absent = 0. */
  $v?: number;
  /** Fractional key (kernel/order.ts): a node's place among its siblings, a component's among the node's. */
  $order?: string;
};

export type NodeData<T = Record<string, unknown>> = ComponentData<T> & {
  $path: string;
  /** Stable identity (ULID), minted once at first persist and immutable —
   *  survives rename/move/trash-restore (core-gk8.10). Optional: virtual and
   *  legacy nodes may lack it. */
  $id?: string;
  /** On standalone ref nodes: the TARGET's $id (see Ref.$refId). */
  $refId?: string;
  $owner?: string;
  $rev?: number;
};

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
export type Class<T = unknown> = new (...args: any[]) => T;

// Accept string or registered class (registerType stamps $type on constructor)
export type TypeId<T = unknown> = string | Class<T>;

// ── Type normalization ──
// Dot-less types belong to treenix namespace: 'dir' → 't.dir', 'ref' → 't.ref'
// Types with dots are already namespaced and returned as-is
export function normalizeType(type: TypeId): string {
  if (typeof type === 'string') return type.includes('.') ? type : `t.${type}`;
  if ('$type' in type && typeof type.$type === 'string') return normalizeType(type.$type);
  throw new Error('TypeId: class not registered (missing $type)');
}

// ── Utils ──

export function isComponent(value: unknown): value is ComponentData {
  return typeof value === 'object' && value !== null && '$type' in value;
}

export const AnyType = 't.any';

export function isOfType<T>(value: unknown, type: TypeId): value is ComponentData<T> {
  if (!isComponent(value)) return false;
  const t = normalizeType(type);
  return t === AnyType || t === normalizeType(value.$type);
}

// ── Ref ──
// $refId = target's $id (identity), NOT the ref's own id — a standalone ref
// NODE carries its own $id, so the target id needs a distinct field. Path in
// $ref is a resolvable cache; $refId is the truth (core-gk8.10 stage 2).
export type Ref = { $type?: string; $ref: string; $refId?: string; $map?: string };

export function ref(path: string): Ref {
  return { $type: 'ref', $ref: path };
}

export function isRef(value: unknown): value is Ref {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.$ref === 'string' && (!v.$type || v.$type === 'ref' || v.$type === 't.ref');
}

// ── Node ──

import { assertSafeKey } from './json';

export function assertNonSystemName(name: string) {
  if (name.startsWith('$')) throw new Error(`Component name cannot start with $: ${name}`);
  if (name.startsWith(COMP_PREFIX)) throw new Error(`Component/field name cannot start with ${COMP_PREFIX}: ${name}`);
  assertSafeKey(name);
}

// ── Component namespace (# prefix) ──
// Three disjoint key groups on a node: $x = system fields, bare = the main
// component's own schema fields, #x = attached components (node['#run']).
// Classification is purely the prefix — a bare value carrying $type is plain
// data (e.g. a stored node snapshot), NOT a component. Legacy bare-component
// storage is migrated offline in one pass (scripts/migrate-component-namespace);
// there is no runtime compatibility mode. URLs and $refs already use the
// single-# form (/path#run), so locators never change.
// See docs/engine/core-simplification/component-namespace.md (core-gk8.21).

export const COMP_PREFIX = '#';

export function isCompKey(key: string): boolean {
  return key.startsWith(COMP_PREFIX);
}

function bareName(nameOrKey: string): string {
  const bare = isCompKey(nameOrKey) ? nameOrKey.slice(1) : nameOrKey;
  if (!bare) throw new Error('Component name cannot be empty');
  if (bare.includes('.')) throw new Error(`Component name cannot contain ".": ${nameOrKey}`);
  assertNonSystemName(bare);
  return bare;
}

/** 'run' → '#run'. Idempotent on storage keys: '#run' → '#run', never '##run'. */
export function compKey(name: string): string {
  return COMP_PREFIX + bareName(name);
}

/** '#run' → 'run'; 'run' → 'run'. For URLs / $refs locators — single-# form. */
export function compName(key: string): string {
  return bareName(key);
}

function assertWellFormedCompEntry(node: NodeData, key: string, value: unknown): asserts value is ComponentData {
  // A #-key whose value carries no $type is neither a field nor a component —
  // a malformed write slipped past the boundary. Throw, never skip.
  if (!isComponent(value)) {
    throw new Error(`Malformed component entry "${key}" on ${node.$path}: value has no $type`);
  }
}

/** Component lookup by NAME: accepts 'run' or '#run', reads node['#run']. */
export function getComponentByName(node: NodeData, name: string): ComponentData | undefined {
  const bare = isCompKey(name) ? name.slice(1) : name;
  const value = node[COMP_PREFIX + bare];
  if (value === undefined) return undefined;
  assertWellFormedCompEntry(node, COMP_PREFIX + bare, value);
  return value;
}

/** Component-arg keys land in storage under their '#'-prefixed form.
 *  A general string index signature passes through unprefixed so
 *  Record<string, …> component bags stay assignable to NodeData. */
type CompKeyed<C> = { [K in keyof C as K extends string ? (string extends K ? K : `#${K}`) : never]: C[K] };

export function makeNode<T, C = Record<string, ComponentData<any>>>(
  path: string, type: Class<T>, data?: Partial<T>, components?: C): NodeData<T & CompKeyed<C>>;
export function makeNode<T = any, C = Record<string, ComponentData<any>>>(
  path: string, type: string, data?: T, components?: C): NodeData<T & CompKeyed<C>>;
export function makeNode(
  path: string,
  type: TypeId,
  data?: any,
  components?: any): NodeData {

  const node: NodeData = { $path: path, $type: normalizeType(type) } as NodeData;
  if (data) Object.keys(data).forEach(assertNonSystemName);
  Object.assign(node, data);

  if (components) {
    for (const [name, comp] of Object.entries(components)) {
      if (!isComponent(comp)) throw new Error(`makeNode: component "${name}" has no $type`);
      node[compKey(name)] = comp;
    }
  }

  return node;
}

/** @deprecated Use makeNode — createNode just builds an object, doesn't persist */
export const createNode = makeNode;

export function getComponentField<T = unknown>(
  node: NodeData,
  type: TypeId<T>,
  field?: string,
): [ComponentData<T>, string] | undefined {
  if (field != null) {
    if (field === '') return isOfType<T>(node, type) ? [node, ''] : undefined;
    // Returns the ACTUAL storage key ('#run') — callers index node[fieldKey]
    // downstream (Immer drafts, patch paths), so the key must match storage.
    const key = COMP_PREFIX + (isCompKey(field) ? field.slice(1) : field);
    const v = node[key];
    if (isOfType<T>(v, type)) return [v, key];
    return;
  }
  if (isOfType<T>(node, type)) return [node, ''];
  for (const [k, v] of Object.entries(node)) {
    if (!isCompKey(k)) continue; // bare keys are data, $ keys are system
    assertWellFormedCompEntry(node, k, v);
    if (isOfType<T>(v, type)) return [v, k];
  }
}

export function getComponent<T = unknown>(
  node: NodeData,
  type: TypeId<T>,
  field?: string,
): ComponentData<T> | undefined {
  return getComponentField(node, type, field)?.[0];
}

// An absent $order is the empty key: it sorts before every generated key, as a missing field does in a Mongo sort.
function byOrderThenName<C extends { $order?: string }>([ak, a]: [string, C], [bk, b]: [string, C]): number {
  const ao = a.$order ?? '', bo = b.$order ?? '';
  if (ao !== bo) return ao < bo ? -1 : 1;
  return ak < bk ? -1 : ak > bk ? 1 : 0;
}

/** The main component '' first, then the named ones by ($order, name). */
export function getComponents<T = unknown>(
  node: NodeData,
  type: TypeId<T> = AnyType,
): [string, ComponentData<T>][] {
  const named: [string, ComponentData<T>][] = [];
  for (const [k, v] of Object.entries(node)) {
    if (!isCompKey(k)) continue; // bare keys are data, $ keys are system
    assertWellFormedCompEntry(node, k, v);
    if (isOfType<T>(v, type)) named.push([k, v]);
  }
  named.sort(byOrderThenName);
  return isOfType<T>(node, type) ? [['', node], ...named] : named;
}

export function removeComponent(node: NodeData, name: string): boolean {
  const key = compKey(name);
  if (!isComponent(node[key])) return false;
  delete node[key];
  return true;
}
