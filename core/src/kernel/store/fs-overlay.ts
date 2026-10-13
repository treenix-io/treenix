import { createHash } from 'node:crypto'
import { open, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { KernelError } from '#errors'
import { safeJsonParse } from '#util/json';
import { isRecord } from '#util/is-record'
import { assertPathSafe } from '#util/path-safety'
import { DEFAULT_LIMITS, type Budget, type Path, type StoreCommit } from '#kernel/types'
import type { FsPhysicalLayout, FsPhysicalCost } from './fs'
import { durableDirectory, durableWrite, missing } from './fs-io'
import { scanFsNodes, writeFsNode, fsWriteSafe } from './fs-layout'

interface OverlayCost { nodes: number; bytes: number; exprWork: number }

/** Resolve existing ancestors before creating an upper directory or acquiring its lease. */
async function plannedDirectory(path: string): Promise<string> {
  let current = resolve(path), work = 0
  const suffix: string[] = [], deadline = Date.now() + DEFAULT_LIMITS.queryMs
  while (true) {
    if (++work > DEFAULT_LIMITS.exprWork || Date.now() > deadline)
      throw new KernelError('BUDGET', 'Overlay directory resolution exceeded its allowance')
    try {
      const actual = await realpath(current)
      if (Date.now() > deadline) throw new KernelError('BUDGET', 'Overlay directory resolution exceeded its allowance')
      return join(actual, ...suffix.reverse())
    } catch (error) {
      if (!missing(error)) throw error
      suffix.push(basename(current)); current = dirname(current)
    }
  }
}

/** Keep lower bodies readonly while the upper journal owns every visible transition. */
export async function createFsOverlayLayout(upperDirectory: string, baseDirectory: string): Promise<FsPhysicalLayout> {
  const upper = await plannedDirectory(upperDirectory), base = await realpath(resolve(baseDirectory))
  if (upper === base || upper.startsWith(`${base}/`) || base.startsWith(`${upper}/`))
    throw new KernelError('INVALID', 'Overlay physical directories must be disjoint')
  if (!(await stat(base)).isDirectory()) throw new KernelError('INVALID', 'Overlay base capability must be a directory')
  await durableDirectory(upper)

  const markers = join(upper, '.treenix', 'whiteouts')
  function marker(path: Path): string {
    return join(markers, `${createHash('sha256').update(path).digest('hex')}.json`)
  }

  function check(cost: FsPhysicalCost, budget: Budget): void {
    if (Date.now() > budget.deadline || cost.nodes > budget.nodes || cost.bytes > budget.bytes || cost.exprWork > budget.exprWork)
      throw new KernelError('BUDGET', 'Overlay physical allowance exceeded')
  }

  /** Exact-address markers remain sparse; no root-wide marker map is retained. */
  async function hidden(path: Path, cost: OverlayCost, budget: Budget): Promise<boolean> {
    cost.nodes++; cost.exprWork++; check(cost, budget)
    const file = marker(path)
    await assertPathSafe(upper, file)
    let handle
    try { handle = await open(file, 'r') } catch (error) { if (missing(error)) return false; throw error }
    const chunks: Buffer[] = []
    try {
      while (true) {
        check(cost, budget)
        const buffer = Buffer.alloc(Math.min(4096, budget.bytes - cost.bytes + 1))
        const read = await handle.read(buffer)
        cost.bytes += read.bytesRead; cost.exprWork++; check(cost, budget)
        if (read.bytesRead === 0) break
        chunks.push(buffer.subarray(0, read.bytesRead))
      }
    } finally { await handle.close() }
    const content = Buffer.concat(chunks)
    const data: unknown = safeJsonParse(content.toString('utf8'))
    if (!isRecord(data) || data.path !== path || typeof data.deleted !== 'boolean')
      throw new KernelError('INVALID', 'Overlay marker does not match its address')
    return data.deleted
  }

  return {
    externalDirectories: [base],
    externalMetadata: ['.treenix/whiteouts'],
    writeSafe: fsWriteSafe,
    async preflight(commit: StoreCommit) {
      const cost = { nodes: 0, bytes: 0, exprWork: 0 }
      for (const write of commit.writes) {
        cost.nodes++; cost.exprWork++
        cost.bytes += Buffer.byteLength(JSON.stringify({ path: write.path, deleted: write.node === null }))
        check(cost, commit.maintenanceLimits!.budget)
      }
      return cost
    },
    async scan(directory, pos, range, budget, quarantine) {
      if (resolve(directory) !== upper) throw new KernelError('INVALID', 'Overlay upper owner differs')
      const actual = await scanFsNodes(upper, pos, range, budget, quarantine)
      const cost = { ...actual.cost }
      const lower = await scanFsNodes(base, pos, range, { ...budget,
        nodes: budget.nodes - cost.nodes, bytes: budget.bytes - cost.bytes, exprWork: budget.exprWork - cost.exprWork }, quarantine)
      cost.nodes += lower.cost.nodes; cost.bytes += lower.cost.bytes; cost.exprWork += lower.cost.exprWork
      const nodes = new Map(actual.nodes.map(node => [node.$path, node]))
      const hashes = new Map(actual.hashes), faults = [...actual.faults]
      const occupied = new Set([...nodes.keys(), ...faults.map(change => change.path)])
      for (const node of lower.nodes) {
        if (occupied.has(node.$path) || await hidden(node.$path, cost, budget)) continue
        nodes.set(node.$path, node)
        hashes.set(node.$path, lower.hashes.get(node.$path)!)
      }
      for (const fault of lower.faults) {
        if (occupied.has(fault.path) || await hidden(fault.path, cost, budget)) continue
        faults.push(fault)
      }
      check(cost, budget)
      return { nodes: [...nodes.values()], hashes, faults, cost }
    },
    async write(directory, write) {
      if (resolve(directory) !== upper) throw new KernelError('INVALID', 'Overlay upper owner differs')
      const content = await writeFsNode(upper, write)
      await durableWrite(upper, marker(write.path), JSON.stringify({ path: write.path, deleted: write.node === null }))
      return content
    },
  }
}
