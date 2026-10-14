import { KernelError } from '#errors';
import { stableJson } from '#util/stable-json';

export interface ShardIntake {
  readonly owner: string;
  readonly local: string;
  readonly shards: Readonly<Record<string, string>>;
}

/** Retains extractable shard epochs in the same durable token as its origin epoch. */
export function compositeIntake(value: ShardIntake): string {
  return 'shard:' + stableJson(value);
}

/** Checks untrusted mutation tokens without replacing their canonical decision identity. */
export function shardIntakePart(epoch: string, owner: string): string | undefined {
  if (!epoch.startsWith('shard:')) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(epoch.slice(6));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new KernelError('UNKNOWN_OUTCOME', 'Malformed shard intake epoch');
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    !('owner' in value) ||
    typeof value.owner !== 'string' ||
    !('local' in value) ||
    typeof value.local !== 'string' ||
    !('shards' in value) ||
    value.shards === null ||
    typeof value.shards !== 'object' ||
    Array.isArray(value.shards)
  )
    throw new KernelError('UNKNOWN_OUTCOME', 'Malformed shard intake epoch');
  let selected: string | undefined;
  for (const [instance, part] of Object.entries(value.shards)) {
    if (typeof part !== 'string')
      throw new KernelError('UNKNOWN_OUTCOME', 'Malformed shard intake part');
    if (instance === owner) selected = part;
  }
  return value.owner === owner ? value.local : selected;
}
