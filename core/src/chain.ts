// Minimal call-chain: records property/call path, resolves lazily on await.
// Ref resolution is opt-in via runPathWithRefs — chain itself is pure.

import { isRef } from '#core';

export type PathSection = string | unknown[]

// ── Types (mirrors call-chain library, no dep needed) ──

type Primitive = undefined | null | boolean | string | number | symbol | bigint | void

type ValuePromise<T> = T extends Primitive
  ? Promise<T>
  : T extends Promise<any>
  ? T
  : Chain<T>

export type Chain<T> = Promise<T> & {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => ValuePromise<Awaited<NonNullable<R>>>
    : ValuePromise<Awaited<NonNullable<T[K]>>>
}

// TypedRef: runtime $ref + phantom type T for call-chain to follow
// _T is a phantom type — exists only for TypeScript inference, erased at runtime
export interface TypedRef<_T> {
  readonly $type: 'ref'
  $ref: string
}

// Pass registered class (has .$type stamped by registerType) for TypeScript type inference.
// Runtime only stores $ref — no class reference kept.
export function refVal<T>(Comp: (new () => T) & { $type?: string }, defaultPath = ''): TypedRef<T> {
  void Comp  // type-only at runtime; $type from registerType could be stored if needed
  return { $type: 'ref', $ref: defaultPath }
}

// ── Core ──

export async function runPath(target: any, path: PathSection[]): Promise<any> {
  let cur = target, prev = target
  for (const step of path) {
    if (cur == null) throw new Error(`null at step: ${JSON.stringify(step)}`)
    if (typeof step === 'string') { prev = cur; cur = cur[step] }
    else { cur = cur.apply(prev, step as any[]) }
    if (cur?.then) cur = await cur
  }
  return cur
}

// Server executor: same as runPath but auto-follows TypedRef fields
export async function runPathWithRefs(
  target: any,
  path: PathSection[],
  resolveRef: (ref: { $ref: string }) => Promise<any>,
): Promise<any> {
  let cur = target, prev = target
  for (const step of path) {
    if (cur == null) throw new Error(`null at step: ${JSON.stringify(step)}`)
    if (typeof step === 'string') {
      prev = cur
      cur = cur[step]
      if (isRef(cur)) cur = await resolveRef(cur)
    } else {
      cur = cur.apply(prev, step as any[])
    }
    if (cur?.then) cur = await cur
  }
  return cur
}

const make = (target: any, path: PathSection[]): any =>
  new Proxy((() => {}) as any, {
    get: (_, p: string | symbol) => {
      if (p === 'then') return (res: any, rej: any) => runPath(target, path).then(res, rej)
      if (typeof p === 'symbol') return undefined
      return make(target, [...path, p as string])
    },
    apply: (_, __, args) => make(target, [...path, args]),
  })

export const chain = <T>(target: T): Chain<T> => make(target, []) as Chain<T>
