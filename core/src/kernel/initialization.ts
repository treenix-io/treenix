import { KernelError } from '#errors';
import { AUTH_KEY_PATH } from '#kernel/auth-module';
import { LIMITS_PATH, TYPE_PATH } from '#kernel/bootstrap';
import { DEFAULT_LIMITS, type Budget, type Store, type StoredNode } from '#kernel/types';
import { comparePositions } from '#kernel/position';

/** Startup census and stopped-edit recovery share a finite allowance independent of request payload limits. */
export function initializationBudget(): Budget {
  return {
    nodes: Number.MAX_SAFE_INTEGER,
    bytes: Number.MAX_SAFE_INTEGER,
    exprWork: Number.MAX_SAFE_INTEGER,
    deadline: Date.now() + 10_000,
  };
}

/** Retain startup metadata and declarations while ordinary payloads remain in their Store. */
export async function readStoreInitialization(store: Store, mountTypes: ReadonlySet<string>) {
  const budget = initializationBudget(),
    { deadline } = budget;
  const census = await store.scan({ range: { census: '/' }, budget });
  if (census.next !== undefined || Date.now() > deadline)
    throw new KernelError('BUDGET', 'Store initialization census is incomplete');
  const nodes = new Map<string, StoredNode>();
  for (const metadata of census.items) {
    const path = metadata.$path;
    if (
      path !== '/' &&
      path !== AUTH_KEY_PATH &&
      path !== LIMITS_PATH &&
      !path.startsWith(`${TYPE_PATH}/`) &&
      !metadata.chain.types.includes('t.type') &&
      metadata.chain.invalid === undefined &&
      metadata.chain.hasMount !== true &&
      !metadata.chain.types.some((type) => mountTypes.has(type))
    )
      continue;
    const result = await store.scan({
      range: { node: path },
      budget: {
        nodes: 1,
        bytes: DEFAULT_LIMITS.readBytes,
        exprWork: DEFAULT_LIMITS.exprWork,
        deadline,
      },
    });
    const node = result.items[0];
    if (
      result.items.length !== 1 ||
      node.$id !== metadata.$id ||
      node.$path !== path ||
      comparePositions(node.$pos, metadata.$pos) !== 0
    )
      throw new KernelError('INVALID', 'Initialization record differs from the Store census');
    if (Date.now() > deadline)
      throw new KernelError('BUDGET', 'Store initialization exceeded its deadline');
    nodes.set(path, node);
  }
  return { metadata: census.items, nodes };
}
