import { KernelError } from '#errors'
import { createGuard } from '#kernel/guard'
import type { createAcceptedTargets, AcceptedTargetReplacement } from '#kernel/instance-targets'
import type { MountStage, MountTable, PreparedMountReplacement } from '#kernel/mounts'
import { comparePositions, positionToRev } from '#kernel/position'
import { transferImageDigest } from '#kernel/transfer-image'
import { readTransferProvenance } from '#kernel/transfer-provenance'
import type { Budget, ComponentName, Limits, MountDecl, Node, Path, Position, Registry, Store, StoredNode, StoredWrite, TransferCopy, TransferOwnership } from '#kernel/types'
import type { Writer } from '#kernel/writer'
import { stableJson } from '#util/stable-json'
import { ulid } from '#util/ulid'

export interface SubtreeTransfer {
  readonly path: Path
  readonly component: ComponentName
  readonly declaration: MountDecl
}

export interface TransferPreparation {
  readonly before: StoredNode
  readonly draft: StoredNode
  readonly declarationStore: Store
  readonly source: AcceptedTargetReplacement
  readonly replacement: PreparedMountReplacement
  readonly stage: MountStage
  readonly allowance: Budget
  readonly removed: readonly (readonly TransferCopy[])[]
  check(): void
}

export interface TransferOptions {
  readonly writer: Writer
  readonly mounts: MountTable
  readonly registry: Registry
  readonly targets: ReturnType<typeof createAcceptedTargets>
  readonly root: Store
  budget(): Budget
  limits(): Limits
  resolve(path: Path): Store
  retain(replacement: PreparedMountReplacement): void
  handoff(replacement: PreparedMountReplacement): void
  activate(prepared: TransferPreparation): Promise<Position>
}

/** Publish ordinary fields with their original accepted revision, without migrating copied data. */
function publicNode(node: StoredNode): Node {
  const { $pos, ...fields } = node
  return { ...fields, $rev: positionToRev($pos) }
}

/** Copy bounded physical batches off-route; the source influence check owns the eventual switch. */
export async function transferSubtree(options: TransferOptions, input: SubtreeTransfer): Promise<Position> {
  const { mounts, writer } = options
  const operation = options.budget()
  await mounts.prepareRanges([{ subtree: input.path }], operation)
  const declarationStore = options.resolve(input.path)
  const selected = await writer.read([declarationStore.domain], async () => {
    const read = await declarationStore.scan({ range: { node: input.path }, budget: operation })
    return { read, cursor: writer.stream.cursor().pos }
  })
  const before = selected.read.items[0]
  if (before === undefined) throw new KernelError('NOT_FOUND', 'Transfer declaring node is absent')
  const definition = options.registry.type(input.declaration.$type)
  const declaration = { ...input.declaration, $v: definition.version }
  const draft: StoredNode = input.component === '' ? { ...before, ...declaration }
    : Object.assign({ ...before }, { [input.component]: declaration })
  await createGuard({ registry: options.registry, executor: 'kernel', readBefore: async () => before }).transition(before, draft)
  const declarations = mounts.declarationsOf(publicNode(draft))
  const chosen = declarations.declarations.find(entry => entry.component === input.component)
  if (chosen === undefined) throw new KernelError('INVALID', 'Transfer component is not a mount declaration')
  const stage = mounts.stage([declarations])
  const key = stableJson([before.$id, input.component])
  const existing = mounts.ranges().find(range => range.key === key)
  let sourceStore = declarationStore
  if (existing !== undefined) {
    if (existing.pattern !== input.declaration.pattern) throw new KernelError('INVALID', 'Transfer cannot change its routing footprint')
    const source = mounts.target(key, existing.generation)
    if (source.kind !== 'store') throw new KernelError('READ_ONLY', 'Transfer source is not a Store')
    sourceStore = source.store
  }
  const replacement = await mounts.prepareReplacement(chosen, operation, publicNode(before))
  options.retain(replacement)
  const target = replacement.target
  const destination = await target.store.scan({ range: { census: '/' }, budget: operation })
  const retry = await readTransferProvenance(options.root, target.store.blobOwner, operation)
  if (retry !== undefined && (retry.switched !== undefined || retry.intent.node !== before.$id
    || retry.intent.component !== input.component || retry.intent.base !== before.$path
    || retry.intent.pattern !== input.declaration.pattern || retry.intent.source !== sourceStore.blobOwner)) {
    replacement.cancelSession()
    throw new KernelError('CONFLICT', 'Transfer retry has another declaring owner')
  }
  if (destination.items.length !== 0 && retry === undefined) {
    replacement.cancelSession()
    throw new KernelError('CONFLICT', 'Transfer destination is occupied')
  }
  const priorCopies = new Map<Path, TransferCopy>()
  if (retry !== undefined) for (const page of retry.pages) for (const copy of page.copies) priorCopies.set(copy.path, copy)
  let retryBudget = retry?.remaining ?? operation
  for (const item of destination.items) {
    const prior = priorCopies.get(item.$path)
    if (prior === undefined || prior.id !== item.$id) {
      replacement.cancelSession()
      throw new KernelError('CONFLICT', 'Transfer destination contains an unrelated identity')
    }
    const actual = await target.store.scan({ range: { node: item.$path }, budget: retryBudget })
    if (actual.cost === undefined) throw new KernelError('INVALID', 'Transfer destination read has no inspected cost')
    retryBudget = { ...retryBudget, nodes: retryBudget.nodes - actual.cost.nodes,
      bytes: retryBudget.bytes - actual.cost.bytes, exprWork: retryBudget.exprWork - actual.cost.exprWork }
    const image = actual.items[0]
    const work = { exprWork: 0 }
    if (image === undefined || image.$id !== prior.id || comparePositions(image.$pos, prior.pos) !== 0
      || transferImageDigest(image, retryBudget, work) !== prior.copiedDigest) {
      replacement.cancelSession()
      throw new KernelError('CONFLICT', 'Transfer destination image changed before retry')
    }
    retryBudget = { ...retryBudget, exprWork: retryBudget.exprWork - work.exprWork }
  }

  const captured = await writer.read([sourceStore.domain, declarationStore.domain], async () => {
    const paths = new Set<Path>()
    let bytes = 0
    for (const [path, id] of options.targets.target(sourceStore).paths) {
      if (!replacement.entry.range.contains(path) || options.resolve(path) !== sourceStore) continue
      bytes += Buffer.byteLength(JSON.stringify([path, id]))
      if (paths.size >= operation.nodes || bytes > operation.bytes || Date.now() > operation.deadline)
        throw new KernelError('BUDGET', 'Transfer footprint exceeds its budget')
      paths.add(path)
    }
    return { paths, cursor: selected.cursor }
  })
  const source: AcceptedTargetReplacement = { store: sourceStore, paths: captured.paths }
  const domains = [...new Set([sourceStore.domain, declarationStore.domain])]
  const context = { project: publicNode, historyVisible: () => true,
    work: { limit: operation.exprWork, used: 0 }, limits: options.limits() }

  /** Include every descendant and the declaring node, including accepted deletions and identity changes. */
  function check(): void {
    replacement.check()
    mounts.validateStage(stage)
    writer.influence.check({ history: input.path }, [captured.cursor], writer.stream.cursor().pos, domains, context, true)
  }

  const removed: TransferCopy[][] = []
  const batch: StoredWrite[] = []
  const copies: TransferCopy[] = []
  const originals: TransferCopy[] = []
  const absent: Path[] = []
  const ownership: TransferOwnership = { node: before.$id, component: input.component,
    base: before.$path, pattern: input.declaration.pattern, source: sourceStore.blobOwner,
    destination: target.store.blobOwner, cursor: captured.cursor, firstPage: retry?.intent.firstPage ?? 0,
    ...(existing === undefined ? {} : { sourceDeclaration: { node: publicNode(before), component: input.component } }) }
  let allowance = { ...options.budget(), deadline: operation.deadline }
  let started = false
  let sealed = false

  /** Use the remaining source-read allowance for the same physical destination commit. */
  async function publishBatch(): Promise<void> {
    if (!started) options.handoff(replacement)
    await writer.copyTarget(target, batch, allowance, ownership, copies, retry,
      { transferBefore: [...originals], transferAbsent: [...absent], check, begun() { started = true } })
    if (copies.length !== 0) removed.push([...copies])
    batch.length = 0
    copies.length = 0
    originals.length = 0
    absent.length = 0
    allowance = { ...options.budget(), deadline: operation.deadline }
  }

  try {
    for (const [path, prior] of priorCopies) if (!captured.paths.has(path)) {
      batch.push({ path, node: null })
      originals.push({ ...prior, sourceId: prior.id, digest: prior.copiedDigest })
      if (batch.length === options.limits().changeSet) await publishBatch()
    }
    if (batch.length !== 0) await publishBatch()
    for (const path of captured.paths) {
      const read = await writer.read([sourceStore.domain], () => sourceStore.scan({ range: { node: path }, budget: allowance }))
      const node = read.items[0]
      if (node === undefined) throw new KernelError('CONFLICT', 'Transfer source changed during copy')
      if (read.cost === undefined) throw new KernelError('INVALID', 'Transfer source read has no inspected cost')
      allowance = { ...allowance, nodes: allowance.nodes - read.cost.nodes,
        bytes: allowance.bytes - read.cost.bytes, exprWork: allowance.exprWork - read.cost.exprWork }
      const prior = priorCopies.get(path)
      const copied = node.$id.startsWith('p:') ? { ...node,
        $id: prior?.sourceId === node.$id ? prior.id : ulid() } : node
      const imageWork = { exprWork: 0 }
      const digest = transferImageDigest(node, allowance, imageWork)
      const copiedDigest = copied === node ? digest : transferImageDigest(copied, allowance, imageWork)
      allowance = { ...allowance, exprWork: allowance.exprWork - imageWork.exprWork }
      batch.push({ path, node: copied })
      if (prior === undefined) absent.push(path)
      else originals.push({ ...prior, sourceId: prior.id, digest: prior.copiedDigest })
      copies.push({ path, sourceId: node.$id, id: copied.$id, pos: node.$pos, digest, copiedDigest })
      if (batch.length === options.limits().changeSet) await publishBatch()
    }
    if (batch.length !== 0 || !started) await publishBatch()
    await writer.sealCopiedTarget(target, operation.deadline)
    sealed = true
    if (retry !== undefined) await writer.finishCopyRetry(target, retry, allowance)
    check()
  } catch (error) {
    replacement.cancelSession()
    if (started && !sealed) {
      try { await writer.sealCopiedTarget(target, operation.deadline) }
      catch (archiveError) { throw new AggregateError([error, archiveError], 'Transfer copy and census completion failed') }
    }
    throw error
  }

  return options.activate({ before, draft, declarationStore, source, replacement, stage,
    allowance: { ...options.budget(), deadline: operation.deadline }, removed, check })
}
