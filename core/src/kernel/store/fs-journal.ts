import { createHash, randomUUID } from 'node:crypto'
import { open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isSafeKey, safeJsonParse } from '#core/json'
import { KernelError } from '#errors'
import { assertDecisionAliases } from '#kernel/journal'
import type { Executor, JournalEntry, OpId, Position, Principal, StoreCommit, StoredNode } from '#kernel/types'
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
  const record = value.record
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
  assertDecisionAliases(commit.record)
  const paths = new Set<string>()
  for (const write of commit.writes) {
    if (typeof write.path !== 'string' || paths.has(write.path)) throw new KernelError('INVALID', 'Invalid filesystem write address')
    paths.add(write.path)
    if (write.node !== null && (!isRecord(write.node) || typeof write.node.$id !== 'string' || typeof write.node.$type !== 'string'
      || write.node.$path !== write.path || !position(write.node.$pos)
      || !equalPosition(write.node.$pos, commit.pos))) throw new KernelError('INVALID', 'Invalid filesystem node image')
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

export async function openFsJournal(directory: string) {
  const file = join(directory, 'journal.log')
  let data: Buffer
  try { data = await readFile(file) } catch (error) { if (!missing(error)) throw error; data = Buffer.alloc(0) }
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
  const handle = await open(file, 'a+', 0o600)
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
    releaseReplay(): void { commits.length = 0; data = Buffer.alloc(0) },
    async append(commit: StoreCommit): Promise<void> { await handle.writeFile(commitFrame(commit)); await handle.sync() },
    close: () => handle.close(),
  }
}
