import { assertSafePath } from '#core/path'
import { KernelError } from '#errors'
import type { CacheRead } from '#kernel/cache'
import type { CommandOptions } from '#kernel/commands'
import { applyFieldDeltas } from '#kernel/journal'
import type { NodeLaneRead } from '#kernel/lane'
import { computeRights } from '#kernel/rights'
import { R } from '#kernel/types'

export function createNodeLaneRead(options: CommandOptions) {
  const { admission, writer, registry, projector } = options
  if (projector === undefined) throw new KernelError('INVALID', 'A lane requires the instance projector')
  const project = projector
  return async function read<T>(run: (source: NodeLaneRead) => Promise<T>): Promise<T> {
    const budget = options.budget(), input = options.source(budget), revision = options.registryRevision()
    const held: CacheRead[] = []
    let nodes = 0, bytes = 0, live = true
    function check(): void {
      admission.assertActive()
      if (!live) throw new KernelError('INVALID', 'Lane read scope ended')
      if (Date.now() > budget.deadline) throw new KernelError('BUDGET', 'Lane read deadline exceeded')
      if (options.registryRevision() !== revision) throw new KernelError('CONFLICT', 'Projection changed during lane delivery')
    }
    return writer.read(input.domains, async () => {
      check()
      await admission.validate(input.auth)
      const source: NodeLaneRead = {
        pos: writer.stream.cursor().pos, check,
        async image(path) {
          check()
          assertSafePath(path)
          const target = input.resolve(path), chain = target.chain(path)
          const expected = chain.find(node => node.path === path)
          const rights = computeRights(admission.actor, chain, registry)
          for (const alert of rights.alerts) console.error(alert.path, alert.error)
          if (expected === undefined || (rights.bits & R) === 0) return null
          if (nodes >= budget.nodes) throw new KernelError('BUDGET', 'Lane read node budget exceeded')
          const lease = await writer.cache.fill(target.store, { node: path }, { ...budget,
            nodes: budget.nodes - nodes, bytes: budget.bytes - bytes })
          try { check() } catch (error) { lease.release(); throw error }
          held.push(lease)
          const stored = lease.nodes[0]
          if (stored === undefined || stored.$id !== expected.id) throw new KernelError('INVALID', 'Lane metadata differs from its Store')
          nodes++; bytes += Buffer.byteLength(JSON.stringify(stored))
          if (nodes > budget.nodes || bytes > budget.bytes) throw new KernelError('BUDGET', 'Lane read budget exceeded')
          const copy = project(stored, rights.bits)
          check()
          if (copy === null) return null
          const cached = writer.cache.getAt(target.store, path)
          const before = cached?.delta === undefined ? undefined : project(applyFieldDeltas(stored, cached.delta, 'from'), rights.bits)
          if (cached === undefined) throw new KernelError('INVALID', 'Lane image left its retained cache lease')
          return { copy, before, bytes: Math.max(cached.bytes, Buffer.byteLength(JSON.stringify(copy))), retain() { check(); return writer.cache.retain(stored.$id) } }
        },
      }
      try {
        const result = await run(source)
        check()
        return result
      } finally {
        live = false
        for (const lease of held) lease.release()
      }
    })
  }
}
