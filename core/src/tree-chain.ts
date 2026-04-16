// treeChain — tree-aware Proxy chain
// Navigate tree via dots, auto-follow refs, execute actions, typed components.
// Layer L2: uses Tree (L1) + comp (L2). No server dependency.

import { type Class, type Raw, type TypeClass } from '#comp';
import { getComponent, isComponent, isRef, type NodeData, normalizeType, resolve } from '#core';
import { OpError } from '#errors';
import type { Tree } from '#tree';
import type { Chain } from './chain';

type Spec = { cls: Class | null; key?: string }
type Op = string | [string, unknown[]]

// ── Public types ──
// Intersection trick: TreeChainAPI has named props with specific types,
// index signature adds `& TreeChain` via intersection (not interface — no conflicts).
// Result: t.scanner → TreeChain, t.scanner(Scanner) → Chain<Scanner>, await t → NodeData.

type TreeChainAPI = {
  <T>(cls: TypeClass<T>): Chain<T>
  readonly $path: string
  $get<T>(cls: Class<T>, key?: string): Chain<T>
  $field(key: string): Chain<any>
  $children(query?: Record<string, unknown>): Promise<NodeData[]>
  $set<T>(cls: Class<T>, data?: Partial<Raw<T>>): Promise<void>
  then<R1 = NodeData, R2 = never>(
    onfulfilled?: ((value: NodeData) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: any) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2>
}

export type TreeChain = TreeChainAPI & { [k: string]: TreeChain }

const EMPTY_FN = () => {}
const NO_OPS: Op[] = []

async function exec(tree: Tree, path: string, spec: Spec | null, ops: Op[]): Promise<any> {
  const node = await tree.get(path)
  if (!node) throw new OpError('NOT_FOUND', `Node not found: ${path}`)

  let cur: any = node
  let curType = node.$type

  // Apply $get — extract typed or named component
  if (spec) {
    if (spec.key) {
      const ck = node[spec.key]
      if (!isComponent(ck)) throw new Error(`Component "${spec.key}" not found on ${path}`)
      cur = ck
      curType = cur.$type
    } else if (spec.cls) {
      const comp = getComponent(node, spec.cls)
      if (!comp) throw new Error(`Type "${normalizeType(spec.cls)}" not found on ${path}`)
      cur = comp
      curType = comp.$type ?? curType
    }
  }

  // Walk ops: field reads and action calls
  for (const op of ops) {
    if (typeof op === 'string') {
      // Field read
      cur = cur[op]
      if (cur == null) throw new Error(`Field "${op}" is null at ${path}`)

      // Auto-follow $ref
      if (isRef(cur)) {
        const target = await tree.get(cur.$ref)
        if (!target) throw new Error(`Ref not found: ${cur.$ref}`)
        cur = target
        curType = target.$type
      }
    } else {
      // Action call: [name, args]
      const [action, args] = op
      const handler = resolve(curType, `action:${action}`)
      if (!handler) throw new Error(`No action "${action}" for type "${curType}"`)
      const ctx = { node, comp: cur, tree, signal: undefined, nc: undefined, deps: {} }
      cur = await (handler as any)(ctx, args[0])
    }
  }

  return cur
}

function make(tree: Tree, path: string, spec: Spec | null, ops: Op[]): any {
  return new Proxy(EMPTY_FN as any, {
    get: (_, p: string | symbol) => {
      if (p === Symbol.toPrimitive || p === Symbol.toStringTag) return `TreeChain(${path})`
      if (typeof p === 'symbol') return undefined

      if (p === '$path') return path

      if (p === 'then') {
        return (res: any, rej: any) => exec(tree, path, spec, ops).then(res, rej)
      }

      if (p === '$get') {
        return (cls: Class | null, key?: string) =>
          make(tree, path, { cls, key }, NO_OPS)
      }

      if (p === '$field') {
        return (key: string) =>
          make(tree, path, { cls: null, key }, NO_OPS)
      }

      if (p === '$children') {
        return (query?: Record<string, unknown>) =>
          tree.getChildren(path, query ? { query } : undefined).then(r => r.items)
      }

      if (p === '$set') {
        return (cls: Class, data?: Record<string, unknown>) =>
          tree.set({ $path: path, $type: normalizeType(cls), ...data })
      }

      // After [Class] or ops started — accumulate as field ops
      if (spec || ops.length > 0) {
        return make(tree, path, spec, [...ops, p])
      }

      // Child navigation — string concat, no array allocation
      return make(tree, path === '/' ? `/${p}` : `${path}/${p}`, null, NO_OPS)
    },

    apply: (_, __, args) => {
      // Action call — spec set, last op is string → convert to action
      if (spec && ops.length > 0) {
        const last = ops[ops.length - 1]
        if (typeof last === 'string') {
          return make(tree, path, spec, [...ops.slice(0, -1), [last, args]])
        }
      }

      // Class narrowing: proxy(Scanner) → set spec
      const cls = args[0]
      if (args.length === 1 && typeof cls === 'function' && cls.$type) {
        return make(tree, path, { cls, key: undefined }, NO_OPS)
      }

      throw new Error('Call with Class first: t.path(Type).action()')
    },
  })
}

export function treeChain(tree: Tree, basePath?: string): TreeChain {
  const path = basePath
    ? (basePath.startsWith('/') ? basePath : '/' + basePath)
    : '/'
  return make(tree, path, null, NO_OPS)
}
