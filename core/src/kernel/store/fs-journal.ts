import { createHash, randomUUID } from 'node:crypto'
import { open, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { isSafeKey, safeJsonParse } from '#core/json'
import { KernelError } from '#errors'
import { isBlobHoldSnapshot, type BlobHoldSnapshot } from '#kernel/blob-holds'
import { isBlobArchiveMutation } from '#kernel/blob-archives'
import { assertDecisionAliases } from '#kernel/journal'
import { assertMaintenance } from '#kernel/maintenance'
import { assertStoreCommit } from '#kernel/store/commit'
import { acceptsWritePosition, comparePositions } from '#kernel/position'
import type { BlobArchiveMutation, Budget, Executor, JournalEntry, OpId, Position, Principal, StorageFaultChange, StoreCommit, StoredNode } from '#kernel/types'
import { isRecord } from '#util/is-record'
import { durableWrite, missing, syncDirectory } from './fs-io'

function position(value: unknown): value is Position {
  return isRecord(value) && typeof value.instance === 'string' && typeof value.epoch === 'number'
    && Number.isSafeInteger(value.epoch) && value.epoch >= 0 && typeof value.seq === 'number' && Number.isSafeInteger(value.seq) && value.seq >= 0
}

const equalPosition = (a: Position, b: Position): boolean => a.instance === b.instance && a.epoch === b.epoch && a.seq === b.seq
const principal = (value: unknown): value is Principal => typeof value === 'string' && /^(u:|n:|anon:).+/.test(value)
const executor = (value: unknown): value is Executor => value === 'kernel' || principal(value) || typeof value === 'string' && value.startsWith('external:')
const opId = (value: unknown): value is OpId => isRecord(value) && typeof value.epoch === 'string' && typeof value.nonce === 'string' && typeof value.time === 'number' && Number.isFinite(value.time)
function storedNode(value: unknown): value is StoredNode {
  return isRecord(value) && typeof value.$path === 'string' && typeof value.$id === 'string' && typeof value.$type === 'string' && position(value.$pos)
}
/** Checks one decoded journal entry before it enters the Store index. */
function entry(value: unknown): value is JournalEntry {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.path !== 'string' ||
    (value.from !== undefined && typeof value.from !== 'string') ||
    !isRecord(value.change)
  )
    return false
  const change = value.change
  switch (change.t) {
    case 'create':
      return storedNode(change.after)
    case 'delete':
      return storedNode(change.before)
    case 'update':
      return (
        isRecord(change.delta) &&
        Object.values(change.delta).every(isRecord) &&
        (change.after === undefined || storedNode(change.after))
      )
    case 'reconcile':
      return (
        (change.after === null || storedNode(change.after)) &&
        (change.before === undefined || change.before === null || storedNode(change.before))
      )
    default:
      return false
  }
}
/** Checks persisted commit data, including its optional stream decision metadata. */
function storedCommit(value: unknown): value is StoreCommit {
  if (
    !isRecord(value) ||
    !position(value.pos) ||
    typeof value.writerEpoch !== 'number' ||
    !Number.isSafeInteger(value.writerEpoch) ||
    value.writerEpoch < 0 ||
    !Array.isArray(value.writes) ||
    !value.writes.every(
      (write) =>
        isRecord(write) &&
        typeof write.path === 'string' &&
        (write.node === null || storedNode(write.node)),
    ) ||
    !isRecord(value.record)
  )
    return false
  if (value.transferBefore !== undefined && (!Array.isArray(value.transferBefore) || !value.transferBefore.every(original =>
    isRecord(original) && typeof original.path === 'string' && typeof original.sourceId === 'string'
    && typeof original.id === 'string' && typeof original.digest === 'string'
    && typeof original.copiedDigest === 'string' && /^[a-f0-9]{64}$/.test(original.copiedDigest)
    && /^[a-f0-9]{64}$/.test(original.digest) && position(original.pos)))) return false
  const record = value.record
  if (value.transferAbsent !== undefined && (!Array.isArray(value.transferAbsent)
    || !value.transferAbsent.every(path => typeof path === 'string'))) return false
  if (value.acceptedAt !== undefined && (typeof value.acceptedAt !== 'number' || !Number.isFinite(value.acceptedAt))) return false
  if (value.blobArchive !== undefined && (!Array.isArray(value.blobArchive) || !value.blobArchive.every(isBlobArchiveMutation))) return false
  if (value.blobArchive !== undefined && !archiveLimits(value.maintenanceLimits)) return false
  if (value.journalRetentionMs !== undefined && (typeof value.journalRetentionMs !== 'number'
    || !Number.isFinite(value.journalRetentionMs) || value.journalRetentionMs < 0)) return false
  if (record.maintenance !== undefined && (!isRecord(record.maintenance)
    || typeof record.maintenance.journalBefore !== 'number' || !Number.isFinite(record.maintenance.journalBefore)
    || typeof record.maintenance.decisionBefore !== 'number' || !Number.isFinite(record.maintenance.decisionBefore))) return false
  if (record.quarantine !== undefined && (!Array.isArray(record.quarantine) || !record.quarantine.every(change =>
    isRecord(change) && typeof change.path === 'string' && (change.fault === null ||
      isRecord(change.fault) && change.fault.code === 'INVALID' && change.fault.invalid === 'chain')))) return false
  if (
    !position(record.pos) ||
    !executor(record.executor) ||
    !executor(record.caller) ||
    !Array.isArray(record.entries) ||
    !record.entries.every(entry) ||
    !['commit', 'kernel', 'reconcile', 'transfer'].includes(String(record.kind))
  )
    return false
  for (const decision of [record.decision, record.anchorDecision]) {
    if (decision === undefined) continue
    if (
      !isRecord(decision) ||
      !opId(decision.opId) ||
      typeof decision.requestHash !== 'string' ||
      (decision.outcome !== undefined &&
        (!isRecord(decision.outcome) ||
          (decision.outcome.pos !== undefined && !position(decision.outcome.pos)))) ||
      (decision.stream !== undefined &&
        (!isRecord(decision.stream) ||
          !principal(decision.stream.executor) ||
          typeof decision.stream.target !== 'string'))
    )
      return false
  }
  if (record.intake !== undefined) {
    const intake = record.intake
    if (
      !isRecord(intake) ||
      typeof intake.epoch !== 'string' ||
      typeof intake.boundary !== 'number' ||
      !Number.isFinite(intake.boundary) ||
      !isRecord(intake.domains) ||
      !Object.values(intake.domains).every((epoch) => typeof epoch === 'string')
    )
      return false
  }
  return true
}

/** Checks the recorded archive caps; recovery supplies its own fresh execution deadline. */
function archiveLimits(value: unknown): boolean {
  if (!isRecord(value) || typeof value.changeSet !== 'number' || !Number.isSafeInteger(value.changeSet)
    || value.changeSet < 1 || !isRecord(value.budget)) return false
  const budget = value.budget
  return ['nodes', 'bytes', 'exprWork', 'deadline'].every(key =>
    typeof budget[key] === 'number' && Number.isFinite(budget[key]))
}

export function assertStoredJson(value: unknown): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return
  if (Array.isArray(value)) { for (const item of value) assertStoredJson(item); return }
  if (isRecord(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    for (const [key, item] of Object.entries(value)) {
      if (!isSafeKey(key)) throw new KernelError('INVALID', 'Filesystem data contains a forbidden JSON key')
      assertStoredJson(item)
    }
    return
  }
  throw new KernelError('INVALID', 'Filesystem node must contain JSON data')
}

export function validateCommit(commit: StoreCommit): void {
  if (!storedCommit(commit) || !equalPosition(commit.pos, commit.record.pos)) throw new KernelError('INVALID', 'Invalid filesystem commit')
  assertStoredJson(commit)
  assertStoreCommit(commit)
  assertDecisionAliases(commit.record)
  assertMaintenance(commit)
  const paths = new Set<string>()
  for (const write of commit.writes) {
    if (typeof write.path !== 'string' || paths.has(write.path)) throw new KernelError('INVALID', 'Invalid filesystem write address')
    paths.add(write.path)
    if (write.node !== null && (!isRecord(write.node) || typeof write.node.$id !== 'string' || typeof write.node.$type !== 'string'
      || write.node.$path !== write.path || !position(write.node.$pos)
      || !acceptsWritePosition(write.node.$pos, commit.pos, commit.record.kind))) throw new KernelError('INVALID', 'Invalid filesystem node image')
  }
}

export function decodeCommit(text: string): StoreCommit {
  const commit: unknown = safeJsonParse(text)
  if (!storedCommit(commit)) throw new KernelError('INVALID', 'Invalid filesystem journal record')
  validateCommit(commit)
  return commit
}

export function commitFrame(commit: StoreCommit): Buffer {
  const body = Buffer.from(JSON.stringify(commit))
  const header = Buffer.alloc(40)
  header.writeUInt32BE(body.length)
  header.writeUInt32BE((~body.length) >>> 0, 4)
  createHash('sha256').update(body).digest().copy(header, 8)
  return Buffer.concat([header, body])
}

export interface FsSnapshot {
  readonly blobHolds?: BlobHoldSnapshot
  readonly blobArchiveFile?: string
  readonly journalRetentionBoundary?: number
  readonly pos: Position
  readonly writerEpoch: number
  readonly nodes: readonly StoredNode[]
  readonly quarantine: readonly StorageFaultChange[]
  readonly journalFloor: Position
  readonly decisionBoundary: number
  readonly acceptedAt: number
}

/** Decode the selected generation before any persisted image enters the storage shadow. */
export function decodeSnapshot(text: string): FsSnapshot {
  const value: unknown = safeJsonParse(text)
  if (!snapshot(value)) throw new KernelError('INVALID', 'Invalid filesystem generation snapshot')
  assertStoredJson(value)
  if (comparePositions(value.journalFloor, value.pos) > 0) throw new KernelError('INVALID', 'Filesystem journal floor exceeds snapshot')
  const paths = new Set<string>(), ids = new Set<string>()
  for (const node of value.nodes) {
    if (paths.has(node.$path) || ids.has(node.$id) || comparePositions(node.$pos, value.pos) > 0
      || node.$id.startsWith('p:') && node.$id !== `p:${node.$path}`)
      throw new KernelError('INVALID', 'Filesystem snapshot node identity is inconsistent')
    paths.add(node.$path); ids.add(node.$id)
  }
  return value
}

function snapshot(value: unknown): value is FsSnapshot {
  if (isRecord(value) && value.journalRetentionBoundary !== undefined && (typeof value.journalRetentionBoundary !== 'number'
    || !Number.isFinite(value.journalRetentionBoundary))) return false
  if (isRecord(value) && value.blobHolds !== undefined && !isBlobHoldSnapshot(value.blobHolds)) return false
  if (isRecord(value) && value.blobArchiveFile !== undefined && (typeof value.blobArchiveFile !== 'string'
    || !/^blob-archives-[a-f0-9-]+\.log$/.test(value.blobArchiveFile))) return false
  return !(!isRecord(value) || !position(value.pos) || !position(value.journalFloor)
    || typeof value.writerEpoch !== 'number' || !Number.isSafeInteger(value.writerEpoch) || value.writerEpoch < 0
    || !Array.isArray(value.nodes) || !value.nodes.every(storedNode)
    || !Array.isArray(value.quarantine) || !value.quarantine.every(change => isRecord(change)
      && typeof change.path === 'string' && isRecord(change.fault) && change.fault.code === 'INVALID' && change.fault.invalid === 'chain')
    || typeof value.decisionBoundary !== 'number' || !Number.isFinite(value.decisionBoundary) || value.decisionBoundary < 0
    || typeof value.acceptedAt !== 'number' || !Number.isFinite(value.acceptedAt))
}

/** The pointer selects a complete snapshot and WAL pair in one durable rename. */
export async function selectedGeneration(directory: string): Promise<{ snapshot: string; journal: string } | undefined> {
  let text: string
  try { text = await readFile(join(directory, 'generation.json'), 'utf8') }
  catch (error) { if (!missing(error)) throw error; return undefined }
  const value: unknown = safeJsonParse(text)
  if (!isRecord(value) || typeof value.snapshot !== 'string' || typeof value.journal !== 'string'
    || !/^snapshot-[a-f0-9-]+\.json$/.test(value.snapshot) || !/^journal-[a-f0-9-]+\.log$/.test(value.journal)
    || value.snapshot.slice(9, -5) !== value.journal.slice(8, -4))
    throw new KernelError('INVALID', 'Invalid filesystem generation pointer')
  return { snapshot: value.snapshot, journal: value.journal }
}

export type FsPublicationStage = 'snapshotSynced' | 'journalSynced' | 'generationSynced'

export async function openFsJournal(directory: string, name = 'journal.log', selectedSnapshot?: string) {
  const file = join(directory, name)
  let currentJournal = name, currentSnapshot = selectedSnapshot
  let data: Buffer
  try { data = await readFile(file) } catch (error) { if (!missing(error) || name !== 'journal.log') throw error; data = Buffer.alloc(0) }
  const commits: StoreCommit[] = []
  let offset = 0
  while (offset + 40 <= data.length) {
    const length = data.readUInt32BE(offset), end = offset + 40 + length
    if (data.readUInt32BE(offset + 4) !== ((~length) >>> 0)) throw new KernelError('INVALID', 'Filesystem journal header is corrupt')
    if (end > data.length) break
    const body = data.subarray(offset + 40, end)
    if (!createHash('sha256').update(body).digest().equals(data.subarray(offset + 8, offset + 40))) {
      throw new KernelError('INVALID', 'Filesystem journal checksum failed')
    }
    commits.push(decodeCommit(body.toString('utf8')))
    offset = end
  }
  let handle = await open(file, 'a+', 0o600)
  try {
    await syncDirectory(directory)
    if (offset !== data.length) {
      await durableWrite(directory, join(directory, `journal-tail-${randomUUID()}.partial`), data.subarray(offset))
      await handle.truncate(offset)
      await handle.sync()
    }
  } catch (error) { await handle.close(); throw error }
  return {
    commits,
    releaseReplay(): void { data = Buffer.alloc(0) },
    async append(commit: StoreCommit): Promise<void> {
      await handle.writeFile(commitFrame(commit)); await handle.sync(); commits.push(commit)
    },
    async publish(snapshot: FsSnapshot, retained: readonly StoreCommit[], checkpoint?: (stage: FsPublicationStage) => void | Promise<void>,
      archives?: AsyncIterable<BlobArchiveMutation>): Promise<void> {
      const id = randomUUID(), snapshotName = `snapshot-${id}.json`, journalName = `journal-${id}.log`
      const archiveName = `blob-archives-${id}.log`
      if (archives !== undefined) {
        const archive = await open(join(directory, archiveName), 'wx', 0o600)
        try {
          for await (const unit of archives) await archive.writeFile(JSON.stringify(unit) + '\n')
          await archive.sync()
        } finally { await archive.close() }
      }
      await durableWrite(directory, join(directory, snapshotName), JSON.stringify({ ...snapshot,
        ...(archives === undefined ? {} : { blobArchiveFile: archiveName }) }))
      await checkpoint?.('snapshotSynced')
      await durableWrite(directory, join(directory, journalName), Buffer.concat(retained.map(commitFrame)))
      await checkpoint?.('journalSynced')
      await durableWrite(directory, join(directory, 'generation.json'), JSON.stringify({ snapshot: snapshotName, journal: journalName }))
      await checkpoint?.('generationSynced')
      const next = await open(join(directory, journalName), 'a+', 0o600)
      const previous = handle
      handle = next
      await previous.close()
      commits.length = 0
      for (const commit of retained) commits.push(commit)
      if (currentSnapshot !== undefined) {
        await unlink(join(directory, currentSnapshot))
        await unlink(join(directory, currentJournal))
        await syncDirectory(directory)
      }
      currentSnapshot = snapshotName
      currentJournal = journalName
    },
    close: () => handle.close(),
  }
}

/** Reads one bounded archive line at a time without allocating the carrier's entire catalogue. */
export async function* readBlobArchives(directory: string, name: string, budget: () => Budget): AsyncIterable<BlobArchiveMutation> {
  const file = await open(join(directory, name), 'r')
  let pending = Buffer.alloc(0)
  try {
    for (;;) {
      const current = budget()
      if (Date.now() > current.deadline) throw new KernelError('BUDGET', 'Archive recovery deadline exceeded')
      const chunk = Buffer.alloc(64 * 1024)
      const read = await file.read(chunk)
      if (read.bytesRead === 0) break
      pending = Buffer.concat([pending, chunk.subarray(0, read.bytesRead)])
      for (;;) {
        const end = pending.indexOf(10)
        if (end < 0) break
        if (end > current.bytes) throw new KernelError('BUDGET', 'Archive recovery byte budget exceeded')
        const value: unknown = safeJsonParse(pending.subarray(0, end).toString('utf8'))
        if (!isBlobArchiveMutation(value)) throw new KernelError('INVALID', 'Malformed archived carrier unit')
        yield value
        pending = pending.subarray(end + 1)
      }
      if (pending.byteLength > current.bytes) throw new KernelError('BUDGET', 'Archive recovery byte budget exceeded')
    }
    if (pending.length !== 0) throw new KernelError('INVALID', 'Incomplete archived carrier unit')
  } finally { await file.close() }
}
