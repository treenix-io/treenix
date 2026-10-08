import type { OpenedMountTarget, OpenedStoreMountTarget } from '#kernel/types'

const owned = new WeakMap<OpenedMountTarget, OpenedMountTarget>()

export function ownMountTarget(target: OpenedStoreMountTarget): OpenedStoreMountTarget
export function ownMountTarget(target: OpenedMountTarget): OpenedMountTarget
/** Share one release Promise across failed opening, Writer retirement and instance shutdown. */
export function ownMountTarget(target: OpenedMountTarget): OpenedMountTarget {
  const previous = owned.get(target)
  if (previous !== undefined) return previous

  let closing: Promise<void> | undefined
  const close = () => closing ??= Promise.resolve().then(() => target.close())
  let result: OpenedMountTarget
  if (target.kind === 'store') result = { kind: 'store', store: target.store, resources: Object.freeze({ ...target.resources }), close }
  else if (target.kind === 'authority') result = { kind: 'authority', authority: target.authority, close }
  else if (target.executor === 'reader') result = { kind: 'view', derive: target.derive, executor: 'reader', close }
  else result = { kind: 'view', derive: target.derive, executor: 'node', close,
    ...(target.sources === undefined ? {} : { sources: target.sources }) }

  owned.set(target, result)
  owned.set(result, result)
  return result
}
