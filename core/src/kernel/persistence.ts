import type { PositionCounter } from '#kernel/types'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { open, readFile, readdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { KernelError } from '#errors'
import { comparePositions } from '#kernel/position'
import { durableDirectory, durableWrite, missing, syncDirectory } from '#kernel/store/fs-io'
import type { Position } from '#kernel/types'

import { isRecord } from '#util/is-record'
import { assertPathSafe } from '#util/path-safety'

interface LeaseState {
  readonly instance: string
  readonly domain: string
  readonly continuity: string
  readonly writerEpoch: number
  readonly positionEpoch: number
  readonly issued?: Position
}

export interface PersistentWriter extends PositionCounter {
  readonly directory: string
  readonly instance: string
  readonly domain: string
  readonly epoch: string
  readonly writerEpoch: number
  assertActive(): void
  run<T>(operation: (authority: { reserveFence(epoch: number): Promise<void> }) => Promise<T>): Promise<T>
  close(): Promise<void>
}

function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }

function decodeState(text: string): LeaseState {
  const value: unknown = JSON.parse(text)
  if (!isRecord(value) || typeof value.instance !== 'string' || typeof value.domain !== 'string'
    || typeof value.continuity !== 'string' || !integer(value.writerEpoch) || !integer(value.positionEpoch)) {
    throw new KernelError('INVALID', 'Invalid persisted writer state')
  }
  return { instance: value.instance, domain: value.domain, continuity: value.continuity,
    writerEpoch: value.writerEpoch, positionEpoch: value.positionEpoch,
    ...(value.issued === undefined ? {} : { issued: decodePosition(JSON.stringify(value.issued), value.instance) }) }
}

function decodePosition(text: string, instance: string): Position {
  const value: unknown = JSON.parse(text)
  if (!isRecord(value) || value.instance !== instance || !integer(value.epoch) || !integer(value.seq)) {
    throw new KernelError('INVALID', 'Invalid persisted position counter')
  }
  return { instance, epoch: value.epoch, seq: value.seq }
}

export async function openPersistentWriter(options: { readonly directory: string; readonly instance: string; readonly pythonExecutable?: string }): Promise<PersistentWriter> {
  const { directory: requestedDirectory, instance, pythonExecutable } = options
  if (instance.length === 0) throw new KernelError('INVALID', 'Instance identity is required')
  await durableDirectory(resolve(requestedDirectory))
  const directory = await realpath(resolve(requestedDirectory))
  const lockPath = join(directory, 'writer.lock')
  await assertPathSafe(directory, lockPath)
  const lock = await open(lockPath, 'a+', 0o600)
  try {
    // flock belongs to the shared open-file description; the Node FD retains it after this helper exits.
    const helper = spawnSync(pythonExecutable ?? 'python3', ['-c',
      'import fcntl,sys\ntry: fcntl.flock(3,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(73)'],
    { stdio: ['ignore', 'ignore', 'pipe', lock.fd], timeout: 10_000, encoding: 'utf8' })
    if (helper.error !== undefined) throw helper.error
    if (helper.status !== 0) throw new KernelError(helper.status === 73 ? 'CONFLICT' : 'UNAVAILABLE', `Cannot acquire filesystem writer lock: ${helper.stderr}`)
    await syncDirectory(directory)
    const statePath = join(directory, 'writer.json'), positionPath = join(directory, 'position.json')
    let state: LeaseState
    await assertPathSafe(directory, statePath)
    try { state = decodeState(await readFile(statePath, 'utf8')) } catch (error) {
      if (!missing(error)) throw error
      if ((await readdir(directory)).some(name => name !== 'writer.lock')) throw new KernelError('INVALID', 'Persistent lease history is missing')
      state = { instance, domain: `fs:${randomUUID()}`, continuity: randomUUID(), writerEpoch: 0, positionEpoch: 0 }
    }
    if (state.instance !== instance) throw new KernelError('INVALID', 'Persistent writer belongs to another instance')
    if (!integer(state.writerEpoch + 1)) throw new KernelError('BUDGET', 'Writer epoch exhausted')
    state = { ...state, writerEpoch: state.writerEpoch + 1 }
    const acquiredEpoch = state.writerEpoch
    await durableWrite(directory, statePath, JSON.stringify(state))
    let active = true, operations = Promise.resolve()
    const assertActive = (): void => { if (!active) throw new KernelError('CONFLICT', 'Filesystem writer lease is closed') }
    const assertCounter = (): void => {
      if (state.writerEpoch !== acquiredEpoch) throw new KernelError('CONFLICT', 'Position counter writer is fenced')
    }
    async function ordered<T>(run: () => Promise<T>): Promise<T> {
      assertActive()
      const pending = operations.then(async () => { assertActive(); return run() })
      operations = pending.then(() => {}, error => { console.error(error) })
      return pending
    }
    return {
      directory, instance: state.instance, domain: state.domain, epoch: state.continuity, writerEpoch: acquiredEpoch, assertActive,
      run: operation => ordered(async () => {
        let valid = true
        try {
          return await operation({ async reserveFence(epoch) {
            if (!valid) throw new KernelError('CONFLICT', 'Writer fence operation has expired')
            if (!integer(epoch) || epoch < state.writerEpoch) throw new KernelError('CONFLICT', 'Writer epoch is stale')
            if (epoch > state.writerEpoch) {
              state = { ...state, writerEpoch: epoch }
              await durableWrite(directory, statePath, JSON.stringify(state))
            }
          } })
        } finally { valid = false }
      }),
      load: () => ordered(async () => {
        assertCounter()
        await assertPathSafe(directory, positionPath)
        try {
          const checkpoint = decodePosition(await readFile(positionPath, 'utf8'), state.instance)
          if (state.issued === undefined || comparePositions(checkpoint, state.issued) > 0) throw new KernelError('INVALID', 'Position checkpoint exceeds the durable issued counter')
          // Gaps have no journal record; an independently retained high-water detects a restored stale checkpoint.
          return comparePositions(checkpoint, state.issued) < 0 ? undefined : checkpoint
        } catch (error) {
          if (missing(error)) return undefined
          throw error
        }
      }),
      save: (position, writerEpoch) => ordered(async () => {
        assertCounter()
        if (writerEpoch !== acquiredEpoch) throw new KernelError('CONFLICT', 'Writer epoch is stale')
        const next = decodePosition(JSON.stringify(position), state.instance)
        if (next.epoch > state.positionEpoch) throw new KernelError('INVALID', 'Position epoch was not reserved')
        if (state.issued !== undefined && comparePositions(next, state.issued) < 0) throw new KernelError('CONFLICT', 'Position counter cannot move backwards')
        state = { ...state, issued: next }
        await durableWrite(directory, statePath, JSON.stringify(state))
        await durableWrite(directory, positionPath, JSON.stringify(next))
      }),
      freshEpoch: previous => ordered(async () => {
        assertCounter()
        if (!integer(previous)) throw new KernelError('INVALID', 'Invalid position epoch floor')
        const epoch = Math.max(previous, state.positionEpoch) + 1
        if (!integer(epoch)) throw new KernelError('BUDGET', 'Position epoch exhausted')
        state = { ...state, positionEpoch: epoch }
        await durableWrite(directory, statePath, JSON.stringify(state))
        return epoch
      }),
      async close() {
        if (!active) return
        active = false
        await operations
        await lock.close()
      },
    }
  } catch (error) { await lock.close(); throw error }
}
