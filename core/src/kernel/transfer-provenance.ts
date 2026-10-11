import { KernelError } from '#errors'
import { comparePositions } from '#kernel/position'
import type { MountEntry, MountTable } from '#kernel/mounts'
import type { AcceptedTargetReplacement } from '#kernel/instance-targets'
import type { Budget, OpenedStoreMountTarget, Position, Registry, Store, TransferCopy, TransferOwnership } from '#kernel/types'
import { transferImageDigest } from '#kernel/transfer-image'

export interface TransferProvenance {
  readonly generation: Position
  readonly intent: TransferOwnership
  readonly switched?: Position
  readonly remaining: Budget
  readonly pages: readonly { readonly page: number; readonly copies: readonly TransferCopy[] }[]
  readonly archivePages: number
}

/** Read bounded physical-copy ownership from the durable archive, independent of retained journal tails. */
export async function readTransferProvenance(root: Store, owner: string, budget: Budget): Promise<TransferProvenance | undefined> {
  let intent: TransferOwnership | undefined
  let generation: Position | undefined
  let switched: Position | undefined
  const pages: { readonly page: number; readonly copies: readonly TransferCopy[] }[] = []
  let archivePages = 0
  let nodes = 0, bytes = 0, work = 0
  for await (const unit of root.blobArchiveCensus(owner)) {
    if (unit.owner !== owner) throw new KernelError('INVALID', 'Archive census returned another physical owner')
    work += unit.t === 'copyPage' ? unit.copies.length : unit.t === 'page'
      ? unit.rows.reduce((sum, row) => sum + 1 + (row.t === 'released' ? 1 : row.ids.length), 0) : 1
    if (work > budget.exprWork || Date.now() > budget.deadline)
      throw new KernelError('BUDGET', 'Transfer ownership work exceeded its allowance')
    nodes += unit.t === 'copyPage' ? unit.copies.length : unit.t === 'page' ? unit.rows.length : 1
    bytes += Buffer.byteLength(JSON.stringify(unit))
    if (nodes > budget.nodes || bytes > budget.bytes)
      throw new KernelError('BUDGET', 'Transfer ownership metadata exceeded its allowance')
    switch (unit.t) {
      case 'begin':
        intent = unit.transfer
        generation = unit.generation
        break
      case 'copyPage':
        if (intent === undefined) throw new KernelError('INVALID', 'Transfer copies have no declaring owner')
        pages.push({ page: unit.page, copies: unit.copies })
        break
      case 'switchTransfer':
        if (intent === undefined) throw new KernelError('INVALID', 'Transfer switch has no declaring owner')
        switched = unit.pos
        break
      case 'page': archivePages++; break
      case 'seal': break
      default: throw new KernelError('INVALID', 'Archive census returned an unapplied mutation')
    }
  }
  if (intent === undefined) return undefined
  if (generation === undefined) throw new KernelError('INVALID', 'Transfer owner has no generation')
  return { intent, generation, pages, archivePages, remaining: { ...budget, nodes: budget.nodes - nodes,
    bytes: budget.bytes - bytes, exprWork: budget.exprWork - work }, ...(switched === undefined ? {} : { switched }) }
}

export interface ReopenedTransferSource {
  readonly source: Store
  readonly writerEpoch: number
  readonly replacement?: AcceptedTargetReplacement
  readonly opened?: OpenedStoreMountTarget
}

/** Reopen only the source physical carrier proven by the accepted transfer's durable owner. */
export async function reopenTransferSource(root: Store, writerEpoch: number, entry: MountEntry,
  target: OpenedStoreMountTarget, mounts: MountTable, registry: Registry,
  budget: Budget): Promise<ReopenedTransferSource | undefined> {
  const proof = await readTransferProvenance(root, target.store.blobOwner, budget)
  if (proof === undefined) return undefined
  const intent = proof.intent
  if (proof.switched === undefined || intent.node !== entry.node.$id || intent.component !== entry.component
    || intent.base !== entry.node.$path || intent.pattern !== entry.declaration.pattern
    || intent.destination !== target.store.blobOwner)
    throw new KernelError('CONFLICT', 'Accepted transfer differs from its selected declaration')
  let source = root
  let sourceEpoch = writerEpoch
  let opened: OpenedStoreMountTarget | undefined
  if (intent.source !== root.blobOwner) {
    const prior = intent.sourceDeclaration
    if (prior === undefined || prior.node.$id !== intent.node || prior.node.$path !== intent.base)
      throw new KernelError('INVALID', 'Transfer physical source has no declaring image')
    const declaration = mounts.declarationsOf(prior.node).declarations.find(value => value.component === prior.component)
    if (declaration === undefined || declaration.declaration.pattern !== intent.pattern)
      throw new KernelError('INVALID', 'Transfer source declaring footprint differs')
    const handler = registry.security(declaration.declaration.$type, 'mount')
    if (handler?.prepare === undefined || registry.type(declaration.declaration.$type).version !== declaration.declaration.$v)
      throw new KernelError('UNAVAILABLE', 'Transfer source physical handler is unavailable')
    opened = await handler.prepare(prior.node, prior.component)
    source = opened.store
    sourceEpoch = opened.resources.writerEpoch
    if (source.blobOwner !== intent.source) {
      await opened.close()
      throw new KernelError('CONFLICT', 'Reopened transfer source has another physical identity')
    }
  }
  try {
    const paths = new Set<string>()
    let remaining = { ...proof.remaining }
    for (const page of proof.pages) for (const copy of page.copies) {
      if (!entry.range.contains(copy.path)) throw new KernelError('INVALID', 'Transfer original is outside its declared footprint')
      const read = await source.scan({ range: { node: copy.path }, budget: remaining })
      if (read.cost === undefined) throw new KernelError('INVALID', 'Transfer source read has no inspected cost')
      remaining = { ...remaining, nodes: remaining.nodes - read.cost.nodes,
        bytes: remaining.bytes - read.cost.bytes, exprWork: remaining.exprWork - read.cost.exprWork }
      const node = read.items[0]
      const imageWork = { exprWork: 0 }
      if (node !== undefined && (node.$id !== copy.sourceId || comparePositions(node.$pos, copy.pos) !== 0
        || transferImageDigest(node, remaining, imageWork) !== copy.digest))
        throw new KernelError('CONFLICT', 'Transfer source original changed before reopening')
      remaining = { ...remaining, exprWork: remaining.exprWork - imageWork.exprWork }
      paths.add(copy.path)
    }
    return { source, writerEpoch: sourceEpoch,
      ...(source === root ? { replacement: { store: source, paths } } : {}),
      ...(opened === undefined ? {} : { opened }) }
  } catch (error) {
    if (opened !== undefined) {
      try { await opened.close() }
      catch (closeError) { throw new AggregateError([error, closeError], 'Transfer source validation and release failed') }
    }
    throw error
  }
}
