import type { Node, Reader, SubSelector } from '#kernel/types';

/** Exhaust a child selection through bounded pages under the actual Reader's authority. */
export async function readAllChildren(
  reader: Reader,
  selector: Omit<Extract<SubSelector, { children: string }>, 'window'>,
): Promise<Node[]> {
  const nodes: Node[] = [];
  let after: string | undefined;
  do {
    const page = await reader.read({
      ...selector,
      window: {
        limit: 100,
        ...(after === undefined ? {} : { after }),
      },
    });
    for (const copy of page.copies) {
      if ('error' in copy) throw copy.error;
      nodes.push(copy.node);
    }
    after = page.next;
  } while (after !== undefined);
  return nodes;
}
