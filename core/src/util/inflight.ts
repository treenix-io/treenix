// Inflight dedup — async memoize that auto-clears on settle.
// First caller runs fn(); concurrent callers share the same Promise.
// Once resolved/rejected, entry is deleted so retries work.

export function createInflight<V>(): (key: string, fn: () => Promise<V>) => Promise<V> {
  const map = new Map<string, Promise<V>>();

  return (key, fn) => {
    let p = map.get(key);
    if (p) return p;
    p = fn().finally(() => map.delete(key));
    map.set(key, p);
    return p;
  };
}
