import { randomUUID } from 'node:crypto';
import { createMemoryStore } from '#kernel/store/memory';
import { position, scanBudget, storeCommit } from '#kernel/store/contract';
import type { StoredNode } from '#kernel/types';
import type { Tree } from '#tree';

/** Exercise the private DSL against native storage without retaining a production backend. */
export function createLabFixtureTree(): Tree {
  const store = createMemoryStore({ domain: 'test' });
  let sequence = 0;

  /** Absence is an ordinary result of an exact node selector. */
  async function readNode(path: string): Promise<StoredNode | undefined> {
    const result = await store.scan({ range: { node: path }, budget: scanBudget() });
    return result.items[0];
  }

  return {
    get: readNode,
    /** The private DSL uses the Store's bounded children selector. */
    async getChildren(path, options) {
      const result = await store.scan({
        range: { children: path }, where: options?.query, budget: scanBudget(),
      });
      return { items: [...result.items] };
    },
    /** Repeated fixture writes retain the node's native identity. */
    async set(node) {
      const before = await readNode(node.$path);
      const after = { ...node, $id: before?.$id ?? randomUUID(), $pos: position(++sequence) };
      await store.commit(storeCommit(sequence, [after], before === undefined ? [] : [before]));
    },
  };
}
