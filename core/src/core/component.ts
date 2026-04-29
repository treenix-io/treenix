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
};

export type RefEntry = { t: string; f?: string; d?: ComponentData };

export type NodeData<T = Record<string, unknown>> = ComponentData<T> & {
  $path: string;
  $owner?: string;
  $rev?: number;
  $refs?: RefEntry[];
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
  if (typeof (type as any).$type === 'string') return normalizeType((type as any).$type);
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
export type Ref = { $type?: string; $ref: string; $map?: string };

export function ref(path: string): Ref {
  return { $type: 'ref', $ref: path };
}

export function isRef(value: unknown): value is Ref {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.$ref === 'string' && (!v.$type || v.$type === 'ref' || v.$type === 't.ref');
}

// ── Node ──

export function assertNonSystemName(name: string) {
  if (name.startsWith('$')) throw new Error(`Component name cannot start with $: ${name}`);
}

export function makeNode<T, C = Record<string, ComponentData<any>>>(
  path: string, type: Class<T>, data?: Partial<T>, components?: C): NodeData<T & C>;
export function makeNode<T = any, C = Record<string, ComponentData<any>>>(
  path: string, type: string, data?: T, components?: C): NodeData<T & C>;
export function makeNode(
  path: string,
  type: TypeId,
  data?: any,
  components?: any): NodeData {

  const node: NodeData = { $path: path, $type: normalizeType(type) } as NodeData;
  if (components) Object.keys(components).forEach(assertNonSystemName);
  if (data) Object.keys(data).forEach(assertNonSystemName);

  Object.assign(node, components, data);

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
    const v = field === '' ? node : node[field];
    if (isOfType<T>(v, type)) return [v, field];
    return;
  }
  if (isOfType<T>(node, type)) return [node, ''];
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith('$')) continue;
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

export function getComponents<T = unknown>(
  node: NodeData,
  type: TypeId<T> = AnyType,
): [string, ComponentData<T>][] {
  const result: [string, ComponentData<T>][] = [];
  if (isOfType<T>(node, type)) result.push(['', node]);
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith('$')) continue;
    if (isOfType<T>(v, type)) result.push([k, v]);
  }
  return result;
}

// ── $ ↔ _ key mapping (Mongo/sift compat) ──

export function toStorageKeys(node: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node))
    out[k.startsWith('$') ? `_${k.slice(1)}` : k] = v;
  return out;
}

export function fromStorageKeys(doc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k === '_id') continue;
    out[k.startsWith('_') ? `$${k.slice(1)}` : k] = v;
  }
  return out;
}

export function removeComponent(node: NodeData, name: string): boolean {
  assertNonSystemName(name);
  if (!isComponent(node[name])) return false;
  delete node[name];
  return true;
}
