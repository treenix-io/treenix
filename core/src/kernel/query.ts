import { assertSafePath } from '#core/path'
import { KernelError } from '#errors'
import { assertSafePredicate } from '#kernel/expr'
import { componentEntries } from '#kernel/migrate'
import { DEFAULT_LIMITS, type MountHandler, type Path, type Where } from '#kernel/types'
import { isRecord } from '#util/is-record'

export interface QueryConfig { readonly source: Path; readonly match: Where }

/** Decode the stored query declaration once at its configuration boundary. */
export function queryConfigOf(component: Record<string, unknown>, _at?: Path): QueryConfig {
  const { source, match } = component
  if (typeof source !== 'string' || !isRecord(match)) throw new KernelError('INVALID', 'Invalid query declaration')
  assertSafePath(source)

  assertSafePredicate(match, DEFAULT_LIMITS, 'viewWhere')
  return { source, match }
}

/** Resolve a query mount into its reader-owned child selector. */
export const queryMountHandler: MountHandler = async node => {
  const component = componentEntries(node).find(([, value]) => value.$type === 't.mount.query')?.[1]
  if (component === undefined) throw new KernelError('INVALID', 'Query declaration has no mount component')
  const { source, match } = queryConfigOf(component)
  return { kind: 'view', executor: 'reader', selector: { children: source, where: match }, async close() {} }
}
