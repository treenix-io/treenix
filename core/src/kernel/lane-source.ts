import { dirname } from '#core/path'
import { KernelError } from '#errors'
import type { CacheRead } from '#kernel/cache'
import type { CommandOptions } from '#kernel/commands'
import type { NodeLaneRead } from '#kernel/lane'
import { createReader } from '#kernel/reader'
import type { Budget, Path, SubSelector } from '#kernel/types'

/** Shares one Reader and its cache leases across a lane's ordered delivery preparation. */
export function createNodeLaneRead(options: CommandOptions, claimable: (path: Path) => boolean) {
  const { admission, writer, registry, projector } = options
  if (projector === undefined) throw new KernelError('INVALID', 'A lane requires the instance projector')
  const project = projector
  /** Keeps selection images usable until preparation and its final lifetime check complete. */
  return async function read<T>(
      run: (source: NodeLaneRead) => Promise<T>,
      selectors: readonly SubSelector[] = [],
      prepare?: (budget: Budget) => Promise<Budget>,
    ): Promise<T> {
    let budget = options.budget()
    if (prepare !== undefined) budget = await prepare(budget)
    await options.prepareSource(budget, selectors, admission.signal)
    const revision = options.registryRevision()
    const held: CacheRead[] = []
    let live = true
    /** Rejects late reads and projections from a registry generation that has already changed. */
    function check(): void {
      admission.assertActive()
      if (!live) throw new KernelError('INVALID', 'Lane read scope ended')
      if (Date.now() > budget.deadline) throw new KernelError('BUDGET', 'Lane read deadline exceeded')
      if (options.registryRevision() !== revision) throw new KernelError('CONFLICT', 'Projection changed during lane delivery')
    }
    const input = options.source(budget, undefined, selectors)
    const reads = createReader({ admission, writer, registry, source: input, budget,
      limits: options.limits(), projector: project,
      scope: { check, hold(lease) { held.push(lease) } } })
    for (const selector of selectors) {
      const resolved = options.resolveSelector?.(selector) ?? selector
      if ('history' in resolved) throw new KernelError('INVALID', 'A subscription cannot select history')
      // Views and Authorities prepare includes through their owning projected selections.
      const path = 'node' in resolved ? resolved.node : resolved.children
      if (options.viewDefinition?.(resolved) === undefined && options.authority?.(path) !== true)
        await reads.prepare(resolved)
    }
    return writer.read(() => input.domains, async () => {
      check()
      await admission.validate(input.auth)
      await reads.validatePrepared()
      const source: NodeLaneRead = {
        pos: writer.stream.cursor().pos, intake: writer.intake.epoch, check,
        async authorizeView(selector) {
          const path = options.viewDefinition?.(selector)
          if (path !== undefined) await reads.selectInSpan({ node: path })
        },
        claimable(path) {
          check()
          return claimable(path)
        },
        async select(selector, candidates, range) {
          const resolved = options.resolveSelector?.(selector) ?? selector
          if ('history' in resolved) throw new KernelError('INVALID', 'A subscription cannot select history')
          const selection = await reads.selectInSpan(resolved, candidates, range)
          return resolved === selector ? selection : { ...selection,
            fixedIncludes: { ...selection.fixedIncludes, reads: selection.reads } }
        },
        cursor(selector, key) {
          const resolved = options.resolveSelector?.(selector) ?? selector
          if ('history' in resolved) throw new KernelError('INVALID', 'A subscription cannot select history')
          return reads.cursor(resolved, key)
        },
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
