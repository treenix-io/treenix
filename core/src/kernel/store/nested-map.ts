// ── In-memory implementation ──

export type TreeNode<T> = {
  data?: T;
  children: Map<string, TreeNode<T>>;
};

export function treeNavigate<T>(root: TreeNode<T>, path: string): TreeNode<T> | undefined {
  if (path === '/') return root;
  const parts = path.slice(1).split('/');
  let node = root;
  for (const part of parts) {
    const child = node.children.get(part);
    if (!child) return undefined;
    node = child;
  }
  return node;
}

export function treeRemove<T>(root: TreeNode<T>, path: string): void {
  if (path === '/') { delete root.data; return }
  const chain: { parent: TreeNode<T>; key: string; node: TreeNode<T> }[] = []
  let parent = root
  for (const key of path.slice(1).split('/')) {
    const node = parent.children.get(key)
    if (node === undefined) return
    chain.push({ parent, key, node })
    parent = node
  }
  delete parent.data
  for (let i = chain.length - 1; i >= 0; i--) {
    const { parent, key, node } = chain[i]
    if (node.data !== undefined || node.children.size !== 0) break
    parent.children.delete(key)
  }
}

export function* treeWalk<T>(start: TreeNode<T>): Iterable<TreeNode<T>> {
  const stack: Iterator<TreeNode<T>>[] = [[start].values()]
  while (stack.length !== 0) {
    const entry = stack[stack.length - 1].next()
    if (entry.done) { stack.pop(); continue }
    yield entry.value
    stack.push(entry.value.children.values())
  }
}
export function treeEnsure<T>(root: TreeNode<T>, path: string): TreeNode<T> {
  if (path === '/') return root;
  const parts = path.slice(1).split('/');
  let node = root;
  for (const part of parts) {
    let child = node.children.get(part);
    if (!child) {
      child = { children: new Map() };
      node.children.set(part, child);
    }
    node = child;
  }
  return node;
}
