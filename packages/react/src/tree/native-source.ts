import type { TwpClient } from '@treenx/core/client/twp'
import { KernelError } from '@treenx/core/errors'
import type { Cursor, NodeCopy, NodeId, SubSelector } from '@treenx/core/kernel/types'

export interface NativeSnapshot {
  readonly phase: 'loading' | 'ready' | 'error'
  readonly generations: readonly number[]
  readonly members: readonly NodeCopy[]
  readonly included: readonly NodeCopy[]
  readonly next?: Cursor
  readonly error?: KernelError
}

export interface NativeMount {
  getSnapshot(): NativeSnapshot
  subscribe(listener: () => void): () => void
  loadMore(): void
  refetch(): void
  dispose(): void
}

interface Page {
  readonly selector: SubSelector
  active: boolean
  subscription?: ReturnType<TwpClient['sub']>
}

interface Resource {
  readonly key: string
  readonly selector: SubSelector
  readonly owners: Set<Set<() => void>>
  readonly pages: Page[]
  snapshot: NativeSnapshot
  error?: KernelError
}

const EMPTY: NativeSnapshot = Object.freeze({ phase: 'loading', generations: [], members: [], included: [] })
const CLOSED: NativeSnapshot = Object.freeze({ phase: 'error', generations: [], members: [], included: [], error: new KernelError('CANCELLED', 'Native source is closed') })

/** Use the same identity for readable and error copies. */
const identity = (copy: NodeCopy) => 'node' in copy ? copy.node.$id : copy.id

/** Locate a copy even when its payload failed projection. */
const path = (copy: NodeCopy) => 'node' in copy ? copy.node.$path : copy.path

/** Error metadata can change without a new version, so its immutable identity also matters. */
const equalCopies = (a: readonly NodeCopy[], b: readonly NodeCopy[]) => a.length === b.length && a.every((copy, i) => {
  const other = b[i]
  return identity(copy) === identity(other) && copy.ver === other.ver
    && ('node' in copy && 'node' in other ? copy.bits === other.bits : copy === other)
})

/** Keep the implicit page size in the selector used to issue and continue cursor pages. */
const normalized = (selector: SubSelector): SubSelector => 'children' in selector && selector.window === undefined
  ? { ...selector, window: { limit: 100 } } : selector

/** Share only subscriptions with the same query, includes, and window. */
const selectorKey = (selector: SubSelector) => JSON.stringify(normalized(selector))

/** Share client-owned copies across React mounts without owning the client's connection. */
export function createNativeTreeSource(client: TwpClient) {
  const resources = new Map<string, Resource>()
  let closed = false, scheduled = false

  /** Coalesce notifications after the client has applied a complete frame. */
  function schedule(): void {
    if (closed || scheduled) return
    scheduled = true
    queueMicrotask(() => { scheduled = false; refresh() })
  }

  /** Reject new work once the source has released its subscriptions. */
  function available(): void { if (closed) throw new KernelError('CANCELLED', 'Native source is closed') }

  /** Notify each live mount after replacing the shared snapshot. */
  function notify(resource: Resource): void { for (const owner of resource.owners) for (const listener of owner) listener() }

  /** Preserve snapshot identity while all observable membership and copy metadata stay equal. */
  function publish(resource: Resource, next: NativeSnapshot): void {
    const previous = resource.snapshot
    if (previous.phase === next.phase && previous.error === next.error && previous.next === next.next
      && previous.generations.length === next.generations.length && previous.generations.every((gen, i) => gen === next.generations[i])
      && equalCopies(previous.members, next.members) && equalCopies(previous.included, next.included)) return

    resource.snapshot = next
    notify(resource)
  }

  /** Mark pages inactive before closing them so late readiness cannot revive a resource. */
  function stopPages(resource: Resource): void {
    for (const page of resource.pages) { page.active = false; page.subscription?.close() }
    resource.pages.length = 0
  }

  /** Clear visible copies on refusal; a connection failure affects every resource. */
  function fail(resource: Resource, error: KernelError): void {
    const affected = client.failure() === undefined ? [resource] : resources.values()
    for (const entry of affected) {
      entry.error = error
      publish(entry, { phase: 'error', generations: entry.snapshot.generations, members: [], included: [], error })
    }

    refresh()
  }

  /** Open one cursor page once the connection is ready, while its mount remains live. */
  function startPage(resource: Resource, selector: SubSelector): void {
    const page: Page = { selector: structuredClone(selector), active: true }
    resource.pages.push(page)
    void client.ready.then(() => {
      if (!page.active || closed) return
      page.subscription = client.sub(page.selector, schedule, error => { if (page.active) fail(resource, error) })
      void page.subscription.ready.catch((error: KernelError) => { if (page.active) fail(resource, error) })
    }).catch((error: KernelError) => { if (page.active) fail(resource, error) })
  }

  /** Merge page memberships using shared cache copies and the last page's continuation. */
  function snapshot(resource: Resource): NativeSnapshot {
    if (resource.error !== undefined) return { phase: 'error', generations: resource.snapshot.generations, members: [], included: [], error: resource.error }

    const members = new Set<NodeId>(), included = new Set<NodeId>(), generations: number[] = []
    let phase: NativeSnapshot['phase'] = 'ready', next: Cursor | undefined

    for (const page of resource.pages) {
      const list = page.subscription === undefined ? undefined : client.cache.list(page.subscription.id)
      if (list === undefined) { phase = 'loading'; continue }
      generations.push(list.gen)
      if (list.phase === 'loading') phase = 'loading'
      for (const id of list.ids) members.add(id)
      for (const id of list.covered) included.add(id)
      next = list.next
    }

    for (const id of members) included.delete(id)
    const sort = 'children' in resource.selector ? resource.selector.sort ?? [['$order', 1]] : []

    return { phase, generations, members: client.cache.ordered([...members], sort), included: client.cache.ordered([...included], []),
      ...(next === undefined ? {} : { next }) }
  }

  /** Publish window coverage before borrowing or promoting individual node subscriptions. */
  function refresh(): void {
    if (closed) return

    const coverage = new Map<string, NodeCopy>()
    for (const resource of resources.values()) if ('children' in resource.selector) {
      publish(resource, snapshot(resource))
      if (resource.snapshot.phase === 'ready') {
        for (const copy of resource.snapshot.members) coverage.set(path(copy), copy)
        for (const copy of resource.snapshot.included) coverage.set(path(copy), copy)
      }
    }

    for (const resource of resources.values()) if ('node' in resource.selector && resource.error === undefined) {
      const covered = resource.selector.include === undefined ? coverage.get(resource.selector.node) : undefined
      if (covered !== undefined) {
        stopPages(resource)
        publish(resource, { phase: 'ready', generations: [], members: [covered], included: [] })
      } else {
        if (resource.pages.length === 0) startPage(resource, resource.selector)
        publish(resource, snapshot(resource))
      }
    }
  }

  /** Acquire a shared subscription; the last disposal releases its cursor pages. */
  function mount(selector: SubSelector): NativeMount {
    available()

    const key = selectorKey(selector)
    let resource = resources.get(key)
    if (resource === undefined) {
      resource = { key, selector: structuredClone(normalized(selector)), owners: new Set(), pages: [], snapshot: EMPTY }
      resources.set(key, resource)
    }

    const owned = resource, listeners = new Set<() => void>()
    owned.owners.add(listeners)
    if (owned.pages.length === 0 && 'children' in owned.selector) startPage(owned, owned.selector)
    refresh()

    let disposed = false

    /** Prevent a disposed handle from acquiring new subscriptions. */
    function live(): void { available(); if (disposed) throw new KernelError('CANCELLED', 'Native mount is disposed') }

    return {
      /** Remain readable during React cleanup, including after disposal. */
      getSnapshot() { return closed || disposed ? CLOSED : owned.snapshot },
      /** Register this mount's listener without taking another resource reference. */
      subscribe(listener) { live(); listeners.add(listener); return () => { listeners.delete(listener) } },
      /** Append the actual continuation page without merging distinct query windows. */
      loadMore() {
        live()
        if (!('children' in owned.selector) || owned.snapshot.phase !== 'ready' || owned.snapshot.next === undefined) return

        startPage(owned, { ...owned.selector, window: { ...owned.selector.window, limit: owned.selector.window?.limit ?? 100, after: owned.snapshot.next } })
        refresh()
      },
      /** Replace all pages with a fresh subscription for the original selector. */
      refetch() { live(); stopPages(owned); owned.error = undefined; startPage(owned, owned.selector); refresh() },
      /** Release this mount, promoting borrowed nodes before their last coverage closes. */
      dispose() {
        if (disposed) return
        disposed = true; listeners.clear(); owned.owners.delete(listeners)
        if (owned.owners.size !== 0) return

        resources.delete(key)
        // Promote a path before releasing its last covering window.
        refresh()
        stopPages(owned)
        owned.snapshot = EMPTY
      },
    }
  }

  return {
    /** Read without mounting, so React can inspect a stable snapshot during render. */
    getSnapshot(selector: SubSelector): NativeSnapshot { return closed ? CLOSED : resources.get(selectorKey(selector))?.snapshot ?? EMPTY },
    mount,
    /** Hold a mount for the listener's entire subscription lifetime. */
    subscribe(selector: SubSelector, listener: () => void): () => void {
      const handle = mount(selector), unsubscribe = handle.subscribe(listener)
      return () => { unsubscribe(); handle.dispose() }
    },
    /** Append a page while preserving the references held by existing mounts. */
    loadMore(selector: SubSelector): void {
      const handle = mount(selector)
      try { handle.loadMore() } finally { handle.dispose() }
    },
    /** Restart the resource shared by all mounts of this exact selector. */
    refetch(selector: SubSelector): void {
      const handle = mount(selector)
      try { handle.refetch() } finally { handle.dispose() }
    },
    /** Delegate one-shot reads to the admitted native client. */
    read(selector: SubSelector) { available(); return client.read(selector) },
    /** Preserve the client's actual Pending and accepted action outcome. */
    act(...args: Parameters<TwpClient['act']>) { available(); return client.act(...args) },
    /** Preserve the client's actual Pending and commit conflict semantics. */
    commit(...args: Parameters<TwpClient['commit']>) { available(); return client.commit(...args) },
    /** Cancel only the identified client request. */
    cancel(id: string) { available(); client.cancel(id) },
    /** Release owned subscriptions and notify mounts while leaving the client connection owned by its caller. */
    close(): void {
      if (closed) return
      closed = true

      for (const resource of resources.values()) { stopPages(resource); resource.snapshot = CLOSED; notify(resource) }
      resources.clear()
    },
  }
}

export type NativeTreeSource = ReturnType<typeof createNativeTreeSource>
