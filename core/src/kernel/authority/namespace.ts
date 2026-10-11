import { createHash } from 'node:crypto'
import { assertSafePath } from '#core/path'
import { KernelError } from '#errors'
import { positionToRev, revToPosition } from '#kernel/position'
import { A, type Bits, type Budget, type ActionDescriptor, type IncludeSpec, type Node, type NodeCopy, type OpId, type Outcome, type Position, type ReadResult, type LaneOwnership, type Selector, type SubSelector } from '#kernel/types'
import { isRecord } from '#util/is-record'

/** One immutable mount identity owns foreign IDs, paths and position spaces. */
export function createAuthorityNamespace(origin: string, node: string, component: string, base: string, remote: string) {
  assertSafePath(base)
  assertSafePath(remote)
  const namespace = createHash('sha256').update(JSON.stringify([origin, node, component])).digest('hex')
  const prefix = `f:${namespace}:`
  const encode = (value: string) => Buffer.from(value).toString('base64url')

  function decode(value: string): string {
    if (!value.startsWith(prefix)) throw new KernelError('INVALID', 'Foreign identity belongs to another mount')
    const encoded = value.slice(prefix.length), decoded = Buffer.from(encoded, 'base64url').toString()
    if (encode(decoded) !== encoded) throw new KernelError('INVALID', 'Malformed foreign identity')
    return decoded
  }
  function repath(path: string, from: string, to: string): string {
    assertSafePath(path)
    if (path !== from && !path.startsWith(from === '/' ? '/' : `${from}/`))
      throw new KernelError('INVALID', 'Foreign path leaves its mounted range')
    const suffix = path === from ? '' : path.slice(from === '/' ? 0 : from.length)
    return `${to === '/' ? '' : to}${suffix}` || '/'
  }
  const path = (value: string) => repath(value, remote, base)
  const foreignPath = (value: string) => repath(value, base, remote)
  const id = (value: string) => `${prefix}${encode(value)}`
  const position = (value: Position): Position => ({ ...value, instance: id(value.instance) })
  const foreignPosition = (value: Position): Position => ({ ...value, instance: decode(value.instance) })

  /** Walk external JSON iteratively so depth and width share the operation's work allowance. */
  function payload(input: Readonly<Record<string, unknown>>, charge: () => void, reference = path): Record<string, unknown> {
    type Container = Record<string, unknown> | unknown[]
    interface Walk { readonly output: Container; readonly fields: Iterator<readonly [string, unknown]> }
    function* fields(value: Readonly<Record<string, unknown>> | readonly unknown[]): Generator<readonly [string, unknown]> {
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index++) yield [String(index), value[index]]
      } else for (const key in value) if (Object.hasOwn(value, key)) yield [key, Reflect.get(value, key)]
    }
    const output: Record<string, unknown> = {}
    const stack: Walk[] = [{ output, fields: fields(input) }]
    while (stack.length !== 0) {
      const frame = stack[stack.length - 1], next = frame.fields.next()
      charge()
      if (next.done) { stack.pop(); continue }
      const [key, value] = next.value
      for (let index = 0; index < key.length; index += 8) charge()
      if (typeof value === 'string') for (let index = 0; index < value.length; index += 8) charge()
      let mapped: unknown = value
      let child: Walk | undefined
      if (key === '$ref') {
        if (typeof value !== 'string') throw new KernelError('INVALID', 'Malformed foreign reference')
        mapped = reference(value)
      } else if (Array.isArray(value) || isRecord(value)) {
        const nested: Container = Array.isArray(value) ? [] : {}
        mapped = nested
        child = { output: nested, fields: fields(value) }
      }
      Object.defineProperty(frame.output, key, { value: mapped, enumerable: true, configurable: true, writable: true })
      if (child !== undefined) stack.push(child)
    }
    return output
  }
  function mappedNode(value: Node, bits: Bits, charge: () => void): Node {
    const fields = payload(value, charge)
    const mapped: Node = { ...fields, $type: value.$type, $path: path(value.$path), $id: id(value.$id),
      $rev: positionToRev(position(revToPosition(value.$rev))) }
    if ((bits & A) !== 0) return mapped
    const { $acl, $owner, ...node } = mapped
    return node
  }
  function copy(value: NodeCopy, bits: Bits, charge: () => void): NodeCopy {
    return 'node' in value ? { ...value, node: mappedNode(value.node, bits, charge), ver: id(value.ver), bits: value.bits & bits }
      : { ...value, id: id(value.id), path: path(value.path), ver: id(value.ver),
          ...(value.query === undefined ? {} : { query: queryFields(value.query, bits, charge) }),
          ...(value.sort === undefined ? {} : { sort: queryFields(value.sort, bits, charge) }) }
  }
  function queryFields(value: Readonly<Record<string, unknown>>, bits: Bits, charge: () => void): Record<string, unknown> {
    const mapped = sortFields(value, charge)
    if ((bits & A) !== 0) return mapped
    for (const field in mapped) {
      const head = field.split('.')[0]
      if (head === '$acl' || head === '$owner') delete mapped[field]
    }
    return mapped
  }
  function sortFields(value: Readonly<Record<string, unknown>>, charge: () => void): Record<string, unknown> {
    const mapped = payload(value, charge)
    for (const field in value) {
      const item = value[field]
      if (typeof item !== 'string') continue
      if (field === '$id' || field === '$refId') mapped[field] = id(item)
      else if (field === '$path' || field === '$ref' || field.endsWith('.$ref')) mapped[field] = path(item)
      else if (field === '$rev') mapped[field] = positionToRev(position(revToPosition(item)))
    }
    return mapped
  }
  function action(value: ActionDescriptor): ActionDescriptor {
    return { ...value, id: id(value.id), rev: positionToRev(position(revToPosition(value.rev))) }
  }
  function foreignAction(value: ActionDescriptor): ActionDescriptor {
    return { ...value, id: decode(value.id), rev: positionToRev(foreignPosition(revToPosition(value.rev))) }
  }
  function includes(values: readonly IncludeSpec[]): readonly IncludeSpec[] {
    return values.map(value => 'path' in value ? { path: foreignPath(value.path) }
      : { ...value, ...(value.then === undefined ? {} : { then: includes(value.then) }) })
  }
  function cursor(value: string): string { return id(value) }
  function selector(value: SubSelector): SubSelector
  function selector(value: Selector): Selector
  function selector(value: Selector): Selector {
    if ('history' in value) return { ...value, history: foreignPath(value.history),
      ...(value.after === undefined ? {} : { after: foreignPosition(value.after) }) }
    const include = value.include === undefined ? {} : { include: includes(value.include) }
    if ('node' in value) return { ...value, ...include, node: foreignPath(value.node) }
    return { ...value, ...include, children: foreignPath(value.children),
      ...(value.window?.after === undefined ? {} : { window: { ...value.window, after: decode(value.window.after) } }) }
  }
  function result(value: ReadResult, bits: Bits, budget: Budget, consume?: (nodes: number, work: number) => void): ReadResult {
    let work = 0, nodes = 0
    function charge(): void {
      if (++work > budget.exprWork || Date.now() > budget.deadline)
        throw new KernelError('BUDGET', 'Foreign payload mapping exceeded the operation budget')
    }
    function consult(): void {
      charge()
      if (++nodes > budget.nodes) throw new KernelError('BUDGET', 'Foreign result node budget exceeded')
    }
    const lengths = value.list.length + value.copies.length + value.at.length + (value.history?.length ?? 0)
      + (value.computed?.length ?? 0) + (value.rows?.length ?? 0) + (value.viewErrors?.length ?? 0)
    if (lengths > budget.exprWork) throw new KernelError('BUDGET', 'Foreign result mapping exceeded the work budget')
    let knownNodes = value.copies.length + (value.computed?.length ?? 0) + (value.viewErrors?.length ?? 0)
    if (knownNodes > budget.nodes)
      throw new KernelError('BUDGET', 'Foreign result node budget exceeded')
    if (value.history !== undefined) for (const entry of value.history) {
      charge()
      if (entry.before !== null && entry.before !== 'unknown') knownNodes++
      if (entry.after !== null) knownNodes++
      if (knownNodes > budget.nodes) throw new KernelError('BUDGET', 'Foreign result node budget exceeded')
    }
    function text(value: string): void { for (let index = 0; index < value.length; index += 8) charge() }
    function mapId(value: string): string { text(value); return id(value) }
    function mapPath(value: string): string { text(value); return path(value) }
    function mapPosition(value: Position): Position { text(value.instance); return position(value) }
    function mapCopy(value: NodeCopy): NodeCopy {
      text(value.ver)
      if (!('node' in value)) { text(value.id); text(value.path) }
      return copy(value, bits, charge)
    }
    if (value.action !== undefined) {
      text(value.action.id); text(value.action.rev); text(value.action.modules); text(value.action.type)
    }
    if (value.next !== undefined) text(value.next)
    const mapped = { ...value, list: value.list.map(value => { charge(); return mapId(value) }),
      copies: value.copies.map(value => { consult(); return mapCopy(value) }),
      at: value.at.map(value => { charge(); return mapPosition(value) }),
      ...(value.action === undefined ? {} : { action: action(value.action) }),
      ...(value.next === undefined ? {} : { next: cursor(value.next) }),
      ...(value.history === undefined ? {} : { history: value.history.map(entry => {
        charge()
        if (entry.before !== null && entry.before !== 'unknown') consult()
        if (entry.after !== null) consult()
        return { ...entry,
        path: mapPath(entry.path), address: { id: mapId(entry.address.id), pos: mapPosition(entry.address.pos) },
        before: entry.before === null || entry.before === 'unknown' ? entry.before : mappedNode(entry.before, bits, charge),
        after: entry.after === null ? null : mappedNode(entry.after, bits, charge) } }) }),
      ...(value.computed === undefined ? {} : { computed: value.computed.map(value => { consult(); return { ...payload(value, charge), $type: value.$type,
        $id: id(value.$id), $path: path(value.$path), $rev: positionToRev(position(revToPosition(value.$rev))) } }) }),
      ...(value.rows === undefined ? {} : { rows: value.rows.map(value => { charge(); return { ...payload(value, charge), key: value.key } }) }),
      ...(value.viewErrors === undefined ? {} : { viewErrors: value.viewErrors.map(value => { consult(); return { ...value,
        id: mapId(value.id), path: mapPath(value.path), ver: mapId(value.ver),
        ...(value.query === undefined ? {} : { query: queryFields(value.query, bits, charge) }),
        ...(value.sort === undefined ? {} : { sort: queryFields(value.sort, bits, charge) }) } }) }),
      ...(value.viewOwner === undefined ? {} : { viewOwner: { ...value.viewOwner, path: mapPath(value.viewOwner.path) } }),
    }
    const owned = value.ownership === undefined ? undefined
      : ownership(value.ownership, bits, { ...budget, exprWork: budget.exprWork - work }, used => { work += used })
    consume?.(nodes, work)
    return owned === undefined ? mapped : { ...mapped, ownership: owned }
  }
  function outcome(value: Outcome, budget: Budget, consume?: (work: number) => void): Outcome {
    let work = 0
    function charge(): void {
      if (++work > budget.exprWork || Date.now() > budget.deadline)
        throw new KernelError('BUDGET', 'Foreign outcome mapping exceeded the operation budget')
    }
    if (value.pos !== undefined) for (let index = 0; index < value.pos.instance.length; index += 8) charge()
    const mapped = Object.hasOwn(value, 'value') ? payload({ value: value.value }, charge) : {}
    consume?.(work)
    return { ...mapped, ...(value.pos === undefined ? {} : { pos: position(value.pos) }) }
  }
  function ownership(value: LaneOwnership, bits: Bits, budget: Budget, consume: (work: number) => void): LaneOwnership {
    let work = 0
    function charge(count = 1): void {
      work += count
      if (work > budget.exprWork || Date.now() > budget.deadline)
        throw new KernelError('BUDGET', 'Foreign ownership mapping exceeded the operation budget')
    }
    let count = value.fixed.length + value.roots.length
    for (const root of value.roots) { charge(); count += root.covered.length }
    charge(count)
    function identity(value: string): string { charge(Math.ceil(value.length / 8)); return id(value) }
    const fixed: string[] = []
    for (const valueId of value.fixed) fixed.push(identity(valueId))
    const roots: LaneOwnership['roots'][number][] = []
    for (const root of value.roots) {
      const covered: string[] = []
      for (const valueId of root.covered) covered.push(identity(valueId))
      roots.push({ id: identity(root.id), covered, cursor: identity(root.cursor),
        ...(root.query === undefined ? {} : { query: queryFields(root.query, bits, charge) }) })
    }
    consume(work)
    return { fixed, roots }
  }
  function foreignPayload(value: Readonly<Record<string, unknown>>, budget: Budget, consume: (work: number) => void) {
    let work = 0
    const mapped = payload(value, () => {
      if (++work > budget.exprWork || Date.now() > budget.deadline)
        throw new KernelError('BUDGET', 'Foreign request mapping exceeded the operation budget')
    }, foreignPath)
    consume(work)
    return mapped
  }
  function nonce(principal: string, opId: OpId): string {
    return createHash('sha256').update(JSON.stringify([origin, node, component, principal, opId])).digest('hex')
  }
  return { id, foreignId: decode, path, foreignPath, position, foreignPosition,
    action, foreignAction, selector, result, outcome, ownership, nonce, foreignPayload, owns: (value: string) => value.startsWith(prefix), cursor, foreignCursor: decode }
}
