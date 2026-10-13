import { KernelError } from '#errors'
import { comparePositions } from '#kernel/position'
import { compareScanKeys, scanKey } from '#kernel/store/scan'
import type {
  CacheClaim,
  ComputedNode,
  Credential,
  Cursor,
  Frame,
  ErrorCopy,
  Limits,
  LaneChange,
  LaneOwnership,
  LaneProducer,
  NodeCopy,
  NodeId,
  Position,
  Principal,
  Row,
  Sort,
  SubId,
  ViewOwner,
} from '#kernel/types'
import { DEFAULT_LIMITS } from '#kernel/types'
import { applyDelta, getByPath } from '#kernel/update-ops'

export type CacheClaimLimits = Pick<Limits, 'requestBytes' | 'readNodes'>

export interface PersistedLaneCopies {
  readonly principal: Principal
  readonly credential: Credential
  readonly copies: readonly NodeCopy[]
}

export type PersistedLaneChange =
  | { readonly kind: 'owner'; readonly principal: Principal; readonly credential?: Credential }
  | { readonly kind: 'copies'; readonly principal: Principal; readonly credential: Credential;
      readonly changes: ReadonlyMap<NodeId, NodeCopy | null> }

export type LaneMember =
  | { readonly kind: 'copy'; readonly copy: NodeCopy }
  | { readonly kind: 'computed'; readonly node: ComputedNode }

export interface LaneList {
  readonly viewOwner?: ViewOwner
  readonly gen: number
  readonly ownership?: LaneOwnership
  readonly at?: readonly Position[]
  readonly ids: readonly NodeId[]
  readonly covered: readonly NodeId[]
  readonly viewErrors?: readonly ErrorCopy[]
  readonly computed?: readonly ComputedNode[]
  readonly rows?: readonly Row[]
  readonly phase: 'loading' | 'ready'
  readonly next?: Cursor
}
/** Return the stable identity shared by readable and error copies. */
const identity = (copy: NodeCopy) => 'node' in copy ? copy.node.$id : copy.id
/** Return the address shared by readable and error copies. */
const path = (copy: NodeCopy) => 'node' in copy ? copy.node.$path : copy.path

/** Creates a client cache that can offer authenticated copies during reconnect. */
export function createLaneCache() {
  const copies = new Map<NodeId, NodeCopy>(), paths = new Map<string, NodeId>(), lists = new Map<SubId, LaneList>()
  const watermarks = new Map<string, Position>()
  const producers = new Map<string, { readonly owner: LaneProducer; readonly positions: Map<string, Position> }>()
  function producerKey(owner: LaneProducer): string {
    return 'req' in owner ? `req:${owner.req}` : `sub:${owner.sub}:${owner.gen}`
  }
  function watermark(instance: string): Position | undefined {
    let current = watermarks.get(instance)
    if (current !== undefined) return current
    for (const producer of producers.values()) {
      const value = producer.positions.get(instance)
      if (value !== undefined && (current === undefined || comparePositions(value, current) > 0)) current = value
    }
    return current
  }
  function releaseSubscription(sub: string): void {
    const current = lists.get(sub)
    if (current !== undefined) producers.delete(producerKey({ sub, gen: current.gen }))
  }
  function own(owner: LaneProducer, position: Position): void {
    const key = producerKey(owner)
    let producer = producers.get(key)
    if (producer === undefined) { producer = { owner, positions: new Map() }; producers.set(key, producer) }
    const previous = producer.positions.get(position.instance)
    if (previous !== undefined && comparePositions(position, previous) < 0) throw new KernelError('INVALID', 'Producer position regressed')
    producer.positions.set(position.instance, position)
  }
  const persistence = new Set<(change: PersistedLaneChange) => void>()
  let principal: Principal | undefined
  let credential: string | undefined
  let attached = false
  let retained: Map<NodeId, NodeCopy> | undefined

  /** Stage authenticated durable copies as invisible candidates until server coverage accepts them. */
  function admitPersisted(snapshot: PersistedLaneCopies): void {
    if (attached) throw new KernelError('CONFLICT', 'Cache already belongs to an active client')

    const candidates = new Map<NodeId, NodeCopy>()
    for (const copy of snapshot.copies) {
      const id = identity(copy)
      if (candidates.has(id)) throw new KernelError('INVALID', 'Duplicate persisted identity')
      candidates.set(id, copy)
    }

    clear()
    principal = snapshot.principal
    credential = snapshot.credential.token
    retained = candidates
  }

  /** Export only canonical copies with their authenticated owner; optimistic and View data stay outside. */
  function persisted(): PersistedLaneCopies | undefined {
    if (principal === undefined || credential === undefined) return undefined

    return { principal, credential: { token: credential }, copies: [...copies.values()] }
  }
  function clear(): void {
    copies.clear()
    paths.clear()
    lists.clear()
    watermarks.clear()
    producers.clear()
    retained?.clear()
  }
  /** Reuses only copies from the immediately preceding lane with the same explicit credential. */
  function reconnectClaims(
    identity?: Credential,
    limits: CacheClaimLimits = DEFAULT_LIMITS,
  ): readonly CacheClaim[] {
    if (attached) throw new KernelError('CONFLICT', 'Cache already belongs to an active client')
    if (identity === undefined || identity.token !== credential) retained?.clear()
    const claims: CacheClaim[] = []
    if (retained === undefined || retained.size === 0) return claims
    const encoder = new TextEncoder()
    let bytes = encoder.encode(
      JSON.stringify({ t: 'hi', credential: identity, cache: [] }),
    ).byteLength
    for (const [id, copy] of retained) {
      if (claims.length >= limits.readNodes) break
      const claim = { id, ver: copy.ver }
      const cost =
        encoder.encode(JSON.stringify(claim)).byteLength +
        (claims.length === 0 ? 0 : 1)
      if (bytes + cost > limits.requestBytes) break
      bytes += cost
      claims.push(claim)
    }
    return claims
  }
  /** Acquires one lane consumer without making reconnect candidates visible. */
  function attach(identity?: Credential): void {
    if (attached) throw new KernelError('CONFLICT', 'Cache already belongs to an active client')
    if (
      retained !== undefined &&
      retained.size > 0 &&
      identity === undefined
    )
      throw new KernelError('INVALID', 'Reconnect cache requires an explicit credential')
    if (identity?.token !== credential) retained?.clear()
    credential = identity?.token
    attached = true
  }
  /** Ends lane visibility; the borrowing owner decides whether to retain authenticated candidates. */
  function detach(retain: boolean): void {
    if (!attached) throw new KernelError('INVALID', 'Cache has no active client')
    retained = retain && credential !== undefined ? new Map(copies) : undefined
    copies.clear()
    paths.clear()
    lists.clear()
    watermarks.clear()
    producers.clear()
    attached = false
  }
  /** Applies lane frames while removing retained claims as accepted coverage replaces them. */
  function apply(frame: Frame): void {
    if (frame.t === 'welcome') {
      if (principal !== frame.principal) clear()
      principal = frame.principal
      if (frame.credential !== undefined) credential = frame.credential.token
      if (persistence.size !== 0) {
        const change: PersistedLaneChange = { kind: 'owner', principal,
          ...(credential === undefined ? {} : { credential: { token: credential } }) }
        for (const listener of persistence) listener(change)
      }
      return
    }
    const changes = new Map<NodeId, NodeCopy | null>(), membership = new Map<SubId, LaneList>()
    function put(copy: NodeCopy): void {
      if ('node' in copy) changes.set(copy.node.$id, copy)
      else {
        const { query, ...canonical } = copy
        changes.set(copy.id, canonical)
      }
    }
    /** Applies membership changes and whole-node updates without sharing declassified data. */
    function diff(
      sub: SubId,
      gen: number,
      items: Extract<LaneChange, { op: 'list' }>['diff'],
      covered?: readonly NodeId[],
      next?: Cursor,
      computed?: readonly ComputedNode[],
      rows?: readonly Row[],
      viewErrors?: readonly ErrorCopy[],
      updatedCopies: readonly NodeCopy[] = [],
      owner?: { readonly value?: ViewOwner },
      ownership?: LaneOwnership,
      at?: readonly Position[]
    ): void {
      const current = membership.get(sub) ?? lists.get(sub)
      if (current === undefined || current.gen !== gen) return
      const ids = new Set(current.ids)
      for (const item of items) 'add' in item ? ids.add(item.add) : ids.delete(item.remove)
      let derived: readonly ComputedNode[] | undefined
      if (current.computed !== undefined || computed !== undefined) {
        const selected = covered === undefined ? ids : new Set(covered)
        const nodes = new Map<NodeId, ComputedNode>()
        if (current.computed !== undefined)
          for (const node of current.computed) if (selected.has(node.$id) && !viewErrors?.some(error => error.id === node.$id)) nodes.set(node.$id, node)
        if (computed !== undefined)
          for (const node of computed) nodes.set(node.$id, node)
        derived = [...nodes.values()]
      }

      let errors: readonly ErrorCopy[] | undefined
      if (current.viewErrors !== undefined || viewErrors !== undefined) {
        const selected = covered === undefined ? ids : new Set(covered)
        const retainedErrors = new Map<NodeId, ErrorCopy>()
        const valid = new Set([...(computed?.map(node => node.$id) ?? []), ...updatedCopies.map(identity)])
        if (current.viewErrors !== undefined)
          for (const error of current.viewErrors) if (selected.has(error.id) && !valid.has(error.id)) retainedErrors.set(error.id, error)
        if (viewErrors !== undefined) for (const error of viewErrors) retainedErrors.set(error.id, error)
        errors = [...retainedErrors.values()]
      }

      const nextOwnership = ownership ?? current.ownership
      membership.set(sub, {
        gen,
        ...(nextOwnership === undefined ? {} : { ownership: nextOwnership }), at: at ?? current.at,
        phase: current.phase,
        ...((owner === undefined ? current.viewOwner : owner.value) === undefined ? {}
          : { viewOwner: owner === undefined ? current.viewOwner : owner.value }),
        ids: [...ids],
        covered: covered ?? current.covered,
        ...(derived === undefined ? {} : { computed: derived }),
        ...(errors === undefined ? {} : { viewErrors: errors }),
        ...(rows === undefined
          ? (current.rows === undefined ? {} : { rows: current.rows })
          : { rows }),
        ...(next === undefined ? {} : { next })
      })
    }
    switch (frame.t) {
      case 'snap': {
        const previous = lists.get(frame.sub)
        if (previous !== undefined && frame.gen < previous.gen) return
        const computedIds = frame.computed === undefined ? undefined : new Set(frame.computed.map(node => node.$id))
        const ownedIds = computedIds === undefined && frame.viewErrors === undefined ? undefined
          : new Set([...(computedIds ?? []), ...(frame.viewErrors?.map(error => error.id) ?? [])])
        const covered = frame.covered ?? (ownedIds === undefined ? frame.copies.map(identity) : [...frame.copies.map(identity), ...ownedIds])
        membership.set(frame.sub, {
          gen: frame.gen, ...(frame.ownership === undefined ? {} : { ownership: frame.ownership }), at: frame.at,
          ids: [...frame.list],
          covered,
          phase: 'ready',
          ...(frame.viewOwner === undefined ? {} : { viewOwner: frame.viewOwner }),
          ...(frame.computed === undefined ? {} : { computed: frame.computed }),
          ...(frame.rows === undefined ? {} : { rows: frame.rows }),
          ...(frame.viewErrors === undefined ? {} : { viewErrors: frame.viewErrors }),
          ...(frame.next === undefined ? {} : { next: frame.next })
        })
        for (const copy of frame.copies) put(copy)
        for (const id of covered) {
          if (ownedIds?.has(id)) continue
          if (!changes.has(id) && !copies.has(id)) {
            const previous = retained?.get(id)
            if (previous === undefined) throw new KernelError('INVALID', 'Covered member has no cached copy')
            put(previous)
          }
          retained?.delete(id)
        }
        const foreign = new Set(frame.foreign)
        for (const instance of foreign) if (!frame.at.some(pos => pos.instance === instance))
          throw new KernelError('INVALID', 'Foreign snapshot space has no position')
        releaseSubscription(frame.sub)
        for (const pos of frame.at) {
          if (foreign.has(pos.instance)) own({ sub: frame.sub, gen: frame.gen }, pos)
          else if (!watermarks.has(pos.instance)) watermarks.set(pos.instance, pos)
        }
        break
      }
      case 'result': {
        if (lists.get(frame.sub)?.gen !== frame.gen) return
        diff(frame.sub, frame.gen, frame.diff, frame.covered, frame.next, frame.computed, frame.rows, frame.viewErrors, frame.copies, { value: frame.viewOwner }, frame.ownership, frame.at)
        for (const copy of frame.copies) put(copy)
        if (frame.foreign !== undefined) {
          releaseSubscription(frame.sub)
          for (const instance of frame.foreign) {
            const pos = frame.at.find(pos => pos.instance === instance)
            if (pos === undefined) throw new KernelError('INVALID', 'Foreign result space has no position')
            own({ sub: frame.sub, gen: frame.gen }, pos)
          }
        }
        break
      }
      case 'pos': {
        const previous = frame.coverage === true || frame.producer === undefined ? watermarks.get(frame.pos.instance) : watermark(frame.pos.instance)
        if (frame.coverage === true) {
          if (previous === undefined || comparePositions(frame.pos, previous) !== 0)
            throw new KernelError('INVALID', 'Coverage frame differs from its delivered watermark')
        } else if (previous !== undefined && comparePositions(frame.pos, previous) <= 0)
          throw new KernelError('INVALID', 'Lane positions must increase')
        for (const change of frame.changes) {
          switch (change.op) {
            case 'put': put(change.copy); break
            case 'del': changes.set(change.id, null); break
            case 'list': {
              const current = membership.get(change.sub) ?? lists.get(change.sub)
              const at = [frame.pos]
              for (const position of current?.at ?? []) if (position.instance !== frame.pos.instance) at.push(position)
              diff(change.sub, change.gen, change.diff, change.covered, change.next, undefined, undefined, undefined, [], undefined, change.ownership, at)
              break
            }
            case 'patch': {
              const previous = changes.has(change.id) ? changes.get(change.id) : copies.get(change.id)
              if (previous === undefined || previous === null || !('node' in previous) || previous.ver !== change.base)
                throw new KernelError('CONFLICT', 'Lane patch base does not match the cached copy')
              put({ node: applyDelta(previous.node, change.delta), ver: change.ver, bits: change.bits })
              break
            }
          }
        }
        if (frame.coverage !== true) {
          if (frame.producer === undefined) watermarks.set(frame.pos.instance, frame.pos)
          else own(frame.producer, frame.pos)
        }
        break
      }
      case 'reset': {
        releaseSubscription(frame.sub)
        const previous = lists.get(frame.sub)
        if (previous === undefined || frame.gen > previous.gen) lists.set(frame.sub, { gen: frame.gen, ids: [], covered: [], phase: 'loading' })
        return
      }
      case 'end': releaseSubscription(frame.sub); lists.delete(frame.sub); return
      default: return
    }
    for (const id of changes.keys()) {
      const previous = copies.get(id)
      if (previous !== undefined && paths.get(path(previous)) === id) paths.delete(path(previous))
    }
    for (const [id, copy] of changes) {
      retained?.delete(id)
      if (copy === null) copies.delete(id)
      else { copies.set(id, copy); paths.set(path(copy), id) }
    }
    for (const [sub, list] of membership) lists.set(sub, list)
    if (persistence.size !== 0 && changes.size !== 0 && principal !== undefined && credential !== undefined) {
      const change: PersistedLaneChange = { kind: 'copies', principal, credential: { token: credential }, changes }
      for (const listener of persistence) listener(change)
    }
  }
  /** Orders direct owned members; the first live page owns overlapping IDs. */
  function orderedView(sub: SubId | readonly SubId[], sort: Sort): readonly LaneMember[] {
    const selected = new Map<NodeId, LaneMember>()
    for (const id of typeof sub === 'string' ? [sub] : sub) {
      const list = lists.get(id)
      if (list === undefined)
        throw new KernelError('INVALID', 'Subscription has no members')
      const nodes = new Map(list.computed?.map(node => [node.$id, node]))
      const errors = new Map(list.viewErrors?.map(error => [error.id, error]))
      let queryRoots: Map<string, Readonly<Record<string, unknown>> | undefined> | undefined
      for (const member of list.ids) {
        const node = nodes.get(member)
        const copy = node === undefined ? errors.get(member) ?? (list.computed === undefined ? copies.get(member) : undefined) : undefined
        let value: LaneMember
        if (node !== undefined) value = { kind: 'computed', node }
        else if (copy !== undefined) {
          if (!('node' in copy) && list.ownership !== undefined) {
            queryRoots ??= new Map(list.ownership.roots.map(root => [root.id, root.query]))
            const fields = queryRoots.get(member)
            value = { kind: 'copy', copy: fields === undefined ? copy : { ...copy,
              sort: Object.fromEntries(sort.map(([field]) => [field, getByPath(fields, field)])) } }
          } else value = { kind: 'copy', copy }
        }
        else throw new KernelError('INVALID', 'Subscription member has no owned payload')
        if (!selected.has(member)) selected.set(member, value)
      }
    }
    const members = [...selected.values()].map(member => {
      const key = member.kind === 'computed'
        ? scanKey(member.node, sort, member.node.$path)
        : 'node' in member.copy ? scanKey(member.copy.node, sort, member.copy.node.$path)
        : scanKey(member.copy.sort ?? {}, sort, member.copy.path, (fields, field) => Reflect.get(fields, field))
      return { member, key }
    })

    members.sort((a, b) => compareScanKeys(a.key, b.key, sort))
    return members.map(member => member.member)
  }

  return {
    apply,
    clear,
    attach,
    detach,
    reconnectClaims,
    admitPersisted,
    persisted,
    /** Observe committed changed-ID rows; consumers never need to serialize the complete cache per frame. */
    subscribePersisted(listener: (change: PersistedLaneChange) => void): () => void {
      persistence.add(listener)
      return () => { persistence.delete(listener) }
    },
    copy: (id: NodeId) => copies.get(id),
    at: (path: string) => {
      const id = paths.get(path);
      return id === undefined ? undefined : copies.get(id);
    },
    /** Orders canonical cache copies using the server comparator, including malformed-copy sort fields. */
    ordered(ids: readonly NodeId[], sort: Sort): readonly NodeCopy[] {
      const rows = ids.map((id) => {
        const copy = copies.get(id);
        if (copy === undefined)
          throw new KernelError('INVALID', 'Subscription member has no cached copy');
        const key =
          'node' in copy
            ? scanKey(copy.node, sort, copy.node.$path)
            : scanKey(copy.sort ?? {}, sort, copy.path, (fields, field) =>
                Reflect.get(fields, field),
              );
        return { copy, key };
      });
      rows.sort((a, b) => compareScanKeys(a.key, b.key, sort));
      return rows.map((row) => row.copy);
    },
    orderedView,
    /** Selects computed members without manufacturing ordinary projection metadata. */
    orderedComputed(sub: SubId | readonly SubId[], sort: Sort): readonly ComputedNode[] {
      const ids = typeof sub === 'string' ? [sub] : sub
      for (const id of ids) if (lists.get(id)?.computed === undefined)
        throw new KernelError('INVALID', 'Subscription has no computed members')
      const nodes: ComputedNode[] = []
      for (const member of orderedView(ids, sort))
        if (member.kind === 'computed') nodes.push(member.node)
      return nodes
    },
    list: (sub: SubId) => lists.get(sub),
    watermark,
    releaseProducer: (owner: LaneProducer) => producers.delete(producerKey(owner)),
    claims: () => [...copies].map(([id, copy]) => ({ id, ver: copy.ver })),
    forget: (sub: SubId) => { releaseSubscription(sub); return lists.delete(sub) },
  };
}

export type LaneCache = ReturnType<typeof createLaneCache>
