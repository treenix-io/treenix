export type BoundedCache<K, V> = {
  readonly size: number;
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  delete(key: K): boolean;
  clear(): void;
  deleteWhere(predicate: (value: V, key: K) => boolean): number;
  entries(): IterableIterator<[K, V]>;
};

export function createBoundedCache<K, V>(maxItems: number): BoundedCache<K, V> {
  if (!Number.isInteger(maxItems) || maxItems < 1) {
    throw new Error(`createBoundedCache: maxItems must be a positive integer, got ${maxItems}`);
  }

  const map = new Map<K, V>();

  return {
    get size() {
      return map.size;
    },

    get(key) {
      return map.get(key);
    },

    set(key, value) {
      if (map.has(key)) map.delete(key);
      else if (map.size >= maxItems) {
        const first = map.keys().next();
        if (!first.done) map.delete(first.value);
      }
      map.set(key, value);
    },

    delete(key) {
      return map.delete(key);
    },

    clear() {
      map.clear();
    },

    deleteWhere(predicate) {
      let count = 0;
      for (const [key, value] of map) {
        if (!predicate(value, key)) continue;
        map.delete(key);
        count++;
      }
      return count;
    },

    entries() {
      return map.entries();
    },
  };
}
