export type BoundedCacheOpts<K, V> = {
  /** Called for every eviction (FIFO + manual delete + deleteWhere + clear).
   *  Used by callers that own external resources tied to cache entries
   *  (e.g. withMounts aborts external-watch consumers on mount eviction).
   *  Failures are isolated — a throw from onEvict does NOT abort the
   *  enclosing cache operation, but IS logged. */
  onEvict?: (value: V, key: K) => void;
};

export type BoundedCache<K, V> = {
  readonly size: number;
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  delete(key: K): boolean;
  clear(): void;
  deleteWhere(predicate: (value: V, key: K) => boolean): number;
  entries(): IterableIterator<[K, V]>;
};

export function createBoundedCache<K, V>(maxItems: number, opts?: BoundedCacheOpts<K, V>): BoundedCache<K, V> {
  if (!Number.isInteger(maxItems) || maxItems < 1) {
    throw new Error(`createBoundedCache: maxItems must be a positive integer, got ${maxItems}`);
  }

  const map = new Map<K, V>();
  const onEvict = opts?.onEvict;

  function fireEvict(key: K, value: V) {
    if (!onEvict) return;
    try { onEvict(value, key); }
    catch (err) { console.error('[bounded-cache] onEvict threw:', err); }
  }

  return {
    get size() {
      return map.size;
    },

    get(key) {
      return map.get(key);
    },

    set(key, value) {
      if (map.has(key)) {
        // Replacement — evict the previous value first so callers can release
        // resources held by it.
        const prev = map.get(key)!;
        map.delete(key);
        fireEvict(key, prev);
      } else if (map.size >= maxItems) {
        // FIFO eviction — release the oldest entry's resources.
        const first = map.keys().next();
        if (!first.done) {
          const oldKey = first.value;
          const oldVal = map.get(oldKey)!;
          map.delete(oldKey);
          fireEvict(oldKey, oldVal);
        }
      }
      map.set(key, value);
    },

    delete(key) {
      const v = map.get(key);
      const had = map.delete(key);
      if (had) fireEvict(key, v as V);
      return had;
    },

    clear() {
      if (onEvict) {
        for (const [k, v] of map) fireEvict(k, v);
      }
      map.clear();
    },

    deleteWhere(predicate) {
      let count = 0;
      for (const [key, value] of map) {
        if (!predicate(value, key)) continue;
        map.delete(key);
        fireEvict(key, value);
        count++;
      }
      return count;
    },

    entries() {
      return map.entries();
    },
  };
}
