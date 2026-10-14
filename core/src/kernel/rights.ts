import type { ShardRights } from '#kernel/auth-factory';
import { isChildPath } from '#core/path';
import { KernelError } from '#errors';
import {
  A,
  R,
  W,
  type AclEntry,
  type Actor,
  type Bits,
  type Path,
  type Principal,
  type Registry,
  type RightsPrefix,
  type RuleInput,
  type TypeName,
} from './types';

export interface RightsAlert {
  readonly path: Path;
  readonly field: string;
  readonly error: unknown;
}

interface ChainFields {
  readonly path: Path;
  readonly types: readonly TypeName[];
  readonly acl: readonly AclEntry[];
  readonly owner?: Principal;
  readonly hasAcl: boolean;
  readonly hasOwner: boolean;
  readonly hasMount?: true;
  readonly alerts: readonly RightsAlert[];
}
export type ChainNode = ChainFields &
  (
    | { readonly invalid: 'chain'; readonly id?: string }
    | { readonly invalid?: 'node'; readonly id: string }
  );

export interface RightsResult {
  readonly bits: Bits;
  readonly prefix: RightsPrefix;
  readonly alerts: readonly RightsAlert[];
}

const ALL = R | W | A;

export const validBits = (bits: unknown): bits is Bits =>
  typeof bits === 'number' && Number.isSafeInteger(bits) && bits >= 0 && bits <= ALL;

function rules(
  node: ChainNode & { readonly id: string },
  registry: Registry,
  input: RuleInput,
  alerts: RightsAlert[],
): Bits {
  let mask = ALL;
  for (const name of node.types) {
    try {
      registry.type(name);
    } catch (error) {
      if (!(error instanceof KernelError) || error.code !== 'UNKNOWN_TYPE') throw error;
      alerts.push({ path: node.path, field: '$type', error });
      mask = 0;
      continue;
    }
    const rule = registry.security(name, 'acl');
    if (rule === undefined) continue;
    try {
      const bits = rule(input);
      if (!validBits(bits))
        throw new KernelError('INVALID', 'A rights rule returned an invalid bitmask');
      mask &= bits;
    } catch (error) {
      // The pure fold returns the failure for the writer's admin-alert channel.
      alerts.push({ path: node.path, field: `acl:${name}`, error });
      mask = 0;
    }
  }
  return mask;
}

const actualPath = (path: Path): Path => path;

export function computeRights(
  actor: Actor,
  chain: readonly ChainNode[],
  registry: Registry,
  prefix?: RightsPrefix,
  scopePath: (path: Path) => Path = actualPath,
): RightsResult {
  let granted = prefix?.granted ?? 0,
    denied = prefix?.denied ?? 0;
  let owner = prefix?.owner,
    aboveA = prefix?.aboveA ?? false,
    admin = prefix?.admin ?? false;
  let bits = 0;
  const claims = new Set(actor.claims);
  const alerts: RightsAlert[] = [];
  for (const node of chain) {
    alerts.push(...node.alerts);
    if (node.invalid === 'chain') {
      // Poisoning the fold survives a shard prefix, even for an ancestor A-holder.
      granted = 0;
      denied = ALL;
      aboveA = false;
      bits = 0;
      if (prefix === undefined && node.path === '/') admin = false;
      continue;
    }
    if (node.owner !== undefined) owner = node.owner;
    let principalGrant = 0;
    for (const entry of node.acl) {
      const matches =
        'group' in entry.subject ? claims.has(entry.subject.group) : actor.principal === owner;
      if (!matches) continue;
      if ('grant' in entry) {
        granted |= entry.grant;
        if ('group' in entry.subject && entry.subject.group === actor.principal)
          principalGrant |= entry.grant;
      } else if (!aboveA) denied |= entry.deny;
    }
    const coordinate =
      actor.scope === undefined && actor.writeScope === undefined
        ? node.path
        : scopePath(node.path);
    const scoped =
      actor.scope === undefined ||
      actor.scope.some((path) => path === coordinate || isChildPath(path, coordinate, false));
    bits = scoped ? granted & ~denied & ALL : 0;
    if (
      actor.writeScope !== undefined &&
      !actor.writeScope.some((path) => path === coordinate || isChildPath(path, coordinate, false))
    )
      bits &= R;
    const root = prefix === undefined && node.path === '/';
    const ruleMask = rules(
      node,
      registry,
      { id: node.id, owner, actor, principalGrant, admin: root ? (bits & A) !== 0 : admin },
      alerts,
    );
    bits &= ruleMask;
    if (node.invalid === 'node') bits = 0;
    if (root) admin = (bits & A) !== 0;
    aboveA ||= (bits & A) !== 0;
  }
  return { bits, prefix: { granted, denied, owner, aboveA, admin }, alerts };
}

/** Continue the origin fold only through the receiving shard's bound logical range. */
export function computeAdmittedRights(
  actor: Actor,
  chain: readonly ChainNode[],
  registry: Registry,
  shard?: ShardRights,
  scopePath?: (path: Path) => Path,
): RightsResult {
  if (shard === undefined) return computeRights(actor, chain, registry, undefined, scopePath);
  const local = chain.filter(
    (node) => node.path === shard.path || isChildPath(shard.path, node.path, false),
  );
  return computeRights(actor, local, registry, shard.prefix, scopePath);
}
