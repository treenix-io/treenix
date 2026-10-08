import { readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { KernelError } from '#errors'
import type { PersistentWriter } from '#kernel/persistence'
import { comparePositions } from '#kernel/position'
import type { DecisionRange, JournalCommit, JournalRange, Position, ScanQuery, ScanRange, ScanResult, Store, StoreCommit, StoredNode } from '#kernel/types'
import { stableJson } from '#util/stable-json'
import { assertPathSafe } from '#util/path-safety'
import { durableDirectory, durableWrite, missing } from './fs-io'
import { decodeCommit, openFsJournal, validateCommit } from './fs-journal'
import { fsWriteSafe, readFsNodes, writeFsNode } from './fs-layout'
import { createMemoryStore } from './memory'

export interface FsStoreOptions {
  readonly directory: string
  readonly lease: PersistentWriter
  readonly checkpoint?: (stage: 'beforeRecord' | 'recordSynced' | 'nodeWritten', path?: string) => void | Promise<void>
}

export interface FsStore extends Store {
  readonly directory: string
  close(): Promise<void>
}

export async function createFsStore(options: FsStoreOptions): Promise<FsStore> {
  const lease = options.lease, checkpoint = options.checkpoint, requestedDirectory = options.directory
  lease.assertActive()
  await durableDirectory(resolve(requestedDirectory))
  const directory = await realpath(resolve(requestedDirectory)), stateDirectory = join(directory, '.treenix')
  await assertPathSafe(directory, stateDirectory)
  if (lease.directory !== stateDirectory) throw new KernelError('INVALID', 'Filesystem Store and writer lease directories differ')
  const shadow = createMemoryStore({ domain: lease.domain })
  let failed: unknown, closed = false, closing = false
  let last: Position = { instance: lease.instance, epoch: 0, seq: 0 }
  const assertOpen = (): void => {
    lease.assertActive()
    if (closed) throw new KernelError('UNAVAILABLE', 'Filesystem Store is closed')
    if (failed !== undefined) throw failed
  }
  return lease.run(async () => {
    const snapshotPath = join(stateDirectory, 'snapshot.json'), appliedPath = join(stateDirectory, 'applied.json')
    let snapshot: StoreCommit
    try { snapshot = decodeCommit(await readFile(snapshotPath, 'utf8')) } catch (error) {
      if (!missing(error)) throw error
      try {
        if ((await readFile(join(stateDirectory, 'journal.log'))).length !== 0) throw new KernelError('INVALID', 'Filesystem snapshot is missing')
      } catch (absent) { if (!missing(absent)) throw absent }
      const pos: Position = { instance: lease.instance, epoch: 0, seq: 0 }
      const nodes = await readFsNodes(directory, pos)
      snapshot = { pos, writerEpoch: 0, writes: nodes.map(node => ({ path: node.$path, node })),
        record: { pos, kind: 'kernel', executor: 'kernel', caller: 'kernel', entries: nodes.map(node => ({ id: node.$id, path: node.$path, change: { t: 'create', after: node } })) } }
      await durableWrite(directory, snapshotPath, JSON.stringify(snapshot))
    }
    if (snapshot.pos.instance !== lease.instance) throw new KernelError('INVALID', 'Filesystem snapshot belongs to another instance')
    if (snapshot.writes.length > 0) await shadow.commit(snapshot)
    await assertPathSafe(directory, join(stateDirectory, 'journal.log'))
    const journal = await openFsJournal(stateDirectory)
    try {
      let applied = stableJson(snapshot.pos)
      try { applied = await readFile(appliedPath, 'utf8') } catch (error) { if (!missing(error)) throw error }
      const positions = new Set<string>([stableJson(snapshot.pos)])
      let redo = applied === stableJson(snapshot.pos)
      for (const commit of journal.commits) {
        if (commit.pos.instance !== lease.instance || positions.has(stableJson(commit.pos))) throw new KernelError('INVALID', 'Filesystem journal position is invalid')
        if (comparePositions(commit.pos, last) <= 0) throw new KernelError('INVALID', 'Filesystem journal positions are not increasing')
        last = commit.pos
        positions.add(stableJson(commit.pos))
        await shadow.commit(commit)
        if (redo) for (const write of commit.writes) await writeFsNode(directory, write)
        if (stableJson(commit.pos) === applied) redo = true
      }
      if (!positions.has(applied)) throw new KernelError('INVALID', 'Filesystem apply checkpoint has no journal record')
      last = journal.commits.at(-1)?.pos ?? snapshot.pos
      await durableWrite(directory, appliedPath, stableJson(last))
      const actual = await readFsNodes(directory, last)
      const accepted = await shadow.scan({ range: { subtree: '/' }, budget: { nodes: Number.MAX_SAFE_INTEGER, bytes: Number.MAX_SAFE_INTEGER, exprWork: 0, deadline: Date.now() + 10_000 } })
      const images = (nodes: typeof actual) => stableJson(nodes.map(({ $pos, ...node }) => node).sort((a, b) => a.$path.localeCompare(b.$path)))
      if (images(actual) !== images([...accepted.items])) throw new KernelError('INVALID', 'Filesystem contents differ from accepted storage state')
      journal.releaseReplay()
    } catch (error) { await journal.close(); throw error }
    function scan(query: ScanQuery<ScanRange>): Promise<ScanResult<StoredNode>>
    function scan(query: ScanQuery<JournalRange | DecisionRange>): Promise<ScanResult<JournalCommit>>
    function scan(query: ScanQuery<ScanRange | JournalRange | DecisionRange>): Promise<ScanResult<StoredNode> | ScanResult<JournalCommit>> {
      assertOpen()
      const range = query.range
      return 'journal' in range || 'decision' in range ? shadow.scan({ ...query, range }) : shadow.scan({ ...query, range })
    }
    const store: FsStore = {
      directory, domain: lease.domain,
      scan,
      async commit(input) {
        lease.assertActive()
        const commit = structuredClone(input)
        validateCommit(commit)
        if (closing) throw new KernelError('UNAVAILABLE', 'Filesystem Store is closing')
        await lease.run(async authority => {
          assertOpen()
          if (commit.pos.instance !== lease.instance) throw new KernelError('INVALID', 'Filesystem commit belongs to another instance')
          if (comparePositions(commit.pos, last) <= 0) throw new KernelError('CONFLICT', 'Filesystem commit position is already used')
          for (const write of commit.writes) {
            await fsWriteSafe(directory, write.path)
            if (write.node?.$id.startsWith('p:') && write.node.$id !== `p:${write.path}`) throw new KernelError('INVALID', 'Path identity differs from its address')
          }
          await checkpoint?.('beforeRecord')
          lease.assertActive()
          await authority.reserveFence(commit.writerEpoch)
          try {
            await journal.append(commit)
            await checkpoint?.('recordSynced')
            for (const write of commit.writes) { await writeFsNode(directory, write); await checkpoint?.('nodeWritten', write.path) }
            await durableWrite(directory, appliedPath, stableJson(commit.pos))
            await shadow.commit(commit)
            last = commit.pos
          } catch (error) { failed = error; throw error }
        })
      },
      async close() {
        if (closing) return
        closing = true
        await lease.run(async () => { closed = true; await journal.close() })
      },
    }
    return store
  })
}
