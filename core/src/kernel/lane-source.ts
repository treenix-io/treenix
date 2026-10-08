import { dirname } from '#core/path'
import { KernelError } from '#errors'
import type { CacheRead } from '#kernel/cache'
import type { CommandOptions } from '#kernel/commands'
import type { NodeLaneRead } from '#kernel/lane'
import { createReader } from '#kernel/reader'
import type { SubSelector } from '#kernel/types'

/** Shares one Reader and its cache leases across a lane's ordered delivery preparation. */
export function createNodeLaneRead(options: CommandOptions) {
  const { admission, writer, registry, projector } = options
  if (projector === undefined) throw new KernelError('INVALID', 'A lane requires the instance projector')
  const project = projector
  /** Keeps selection images usable until preparation and its final lifetime check complete. */
  return async function read<T>(run: (source: NodeLaneRead) => Promise<T>, selectors: readonly SubSelector[] = []): Promise<T> {
    const budget = options.budget()
    await options.prepareSource(budget, selectors)
    const input = options.source(budget), revision = options.registryRevision()
    const held: CacheRead[] = []
    let live = true
    /** Rejects late reads and projections from a registry generation that has already changed. */
    function check(): void {
      admission.assertActive()
      if (!live) throw new KernelError('INVALID', 'Lane read scope ended')
      if (Date.now() > budget.deadline) throw new KernelError('BUDGET', 'Lane read deadline exceeded')
      if (options.registryRevision() !== revision) throw new KernelError('CONFLICT', 'Projection changed during lane delivery')
    }
    return writer.read(input.domains, async () => {
      check()
      await admission.validate(input.auth)
      const reads = createReader({ admission, writer, registry, source: input, budget, limits: options.limits(), projector: project,
        scope: { check, hold(lease) { held.push(lease) } } })
      const source: NodeLaneRead = {
        pos: writer.stream.cursor().pos, check,
        select: reads.selectInSpan,
        cursor: reads.cursor,
        /** Resolves eviction order with the same projection and comparator as the window snapshot. */
        async key(path, sort) {
          const parent = dirname(path)
          if (parent === null) throw new KernelError('INVALID', 'The root is not a child window member')
          const selection = await reads.selectInSpan({ children: parent, sort }, [path], {})
          return selection.roots[0]?.member?.key ?? null
        },
        /** Returns the canonical image, with an absent or unreadable target represented by null. */
        async image(path, sort) {
          try { return (await reads.selectInSpan({ node: path }, undefined, undefined, sort)).images[0]! }
          catch (error) {
            if (error instanceof KernelError && error.code === 'NOT_FOUND') return null
            throw error
          }
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
