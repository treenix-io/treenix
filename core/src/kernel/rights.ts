import { isChildPath } from '#core/path'
import { KernelError } from '#errors'
import { A, R, W, type AclEntry, type Actor, type Bits, type Path, type Principal, type Registry,
  type RightsPrefix, type RuleInput, type TypeName } from './types'

export interface RightsAlert {
  readonly path: Path
  readonly field: string
  readonly error: unknown
}

export interface ChainNode {
  readonly path: Path
  readonly id: string
  readonly types: readonly TypeName[]
  readonly acl: readonly AclEntry[]
  readonly owner?: Principal
  readonly hasAcl: boolean
  readonly hasOwner: boolean
  readonly invalid?: 'chain' | 'node'
  readonly alerts: readonly RightsAlert[]
}

export interface RightsResult {
  readonly bits: Bits
  readonly prefix: RightsPrefix
  readonly alerts: readonly RightsAlert[]
}

const ALL = R | W | A

export const validBits = (bits: unknown): bits is Bits => typeof bits === 'number' && Number.isSafeInteger(bits) && bits >= 0 && bits <= ALL

function rules(node: ChainNode, registry: Registry, input: RuleInput, alerts: RightsAlert[]): Bits {
  let mask = ALL
  for (const name of node.types) {
    try { registry.type(name) } catch (error) {
      if (!(error instanceof KernelError) || error.code !== 'UNKNOWN_TYPE') throw error
      alerts.push({ path: node.path, field: '$type', error })
      mask = 0
      continue
    }
    const rule = registry.security(name, 'acl')
    if (rule === undefined) continue
    try {
      const bits = rule(input)
      if (!validBits(bits)) throw new KernelError('INVALID', 'A rights rule returned an invalid bitmask')
      mask &= bits
    } catch (error) {
      // The pure fold returns the failure for the writer's admin-alert channel.
      alerts.push({ path: node.path, field: `acl:${name}`, error })
      mask = 0
    }
  }
  return mask
}

export function computeRights(actor: Actor, chain: readonly ChainNode[], registry: Registry, prefix?: RightsPrefix): RightsResult {
  let granted = prefix?.granted ?? 0, denied = prefix?.denied ?? 0
  let owner = prefix?.owner, aboveA = prefix?.aboveA ?? false, admin = prefix?.admin ?? false
  let bits = 0
  const claims = new Set(actor.claims)
  const alerts: RightsAlert[] = []
  for (const node of chain) {
    alerts.push(...node.alerts)
    if (node.invalid === 'chain') {
      // Poisoning the fold survives a shard prefix, even for an ancestor A-holder.
      granted = 0; denied = ALL; aboveA = false; bits = 0
      if (prefix === undefined && node.path === '/') admin = false
      continue
    }
    if (node.owner !== undefined) owner = node.owner
    for (const entry of node.acl) {
      const matches = 'group' in entry.subject ? claims.has(entry.subject.group) : actor.principal === owner
      if (!matches) continue
      if ('grant' in entry) granted |= entry.grant
      else if (!aboveA) denied |= entry.deny
    }
    const scoped = actor.scope === undefined || actor.scope.some(path => path === node.path || isChildPath(path, node.path, false))
    bits = scoped ? granted & ~denied & ALL : 0
    const root = prefix === undefined && node.path === '/'
    const ruleMask = rules(node, registry, { id: node.id, owner, actor, admin: root ? (bits & A) !== 0 : admin }, alerts)
    bits &= ruleMask
    if (node.invalid === 'node') bits = 0
    if (root) admin = (bits & A) !== 0
    aboveA ||= (bits & A) !== 0
  }
  return { bits, prefix: { granted, denied, owner, aboveA, admin }, alerts }
}
