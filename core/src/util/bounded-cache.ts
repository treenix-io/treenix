export type BoundedCache<K, V> = {
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  delete(key: K): boolean;
  clear(): void;
};

/** FIFO-bounded Map: a set beyond `maxItems` drops the oldest entry; re-setting
 *  a key refreshes its position. */
export function createBoundedCache<K, V>(maxItems: number): BoundedCache<K, V> {
  if (!Number.isInteger(maxItems) || maxItems < 1) {
    throw new Error(`createBoundedCache: maxItems must be a positive integer, got ${maxItems}`);
  }

  const map = new Map<K, V>();

  return {
    get: (key) => map.get(key),

    set(key, value) {
      map.delete(key);
      if (map.size >= maxItems) map.delete(map.keys().next().value!);
      map.set(key, value);
    },

    delete: (key) => map.delete(key),
    clear: () => map.clear(),
  };
}
