// Treenity IDB — thin IndexedDB wrapper for client node cache
// Raw IDB API, no dependencies. Fire-and-forget friendly.
// Degrades silently if IDB unavailable (private browsing, SSR).

import type { NodeData } from '@treenity/core/core';

const DB_NAME = 'treenity';
const DB_VERSION = 1;
const STORE = 'nodes';

export type IDBEntry = {
  path: string;
  data: NodeData;
  lastUpdated: number;
  virtualParent?: string; // only when differs from parentOf(path)
};

let dbPromise: Promise<IDBDatabase> | null = null;

function getDb(): Promise<IDBDatabase> {
  if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'path' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// Load all entries sorted by lastUpdated desc — most recently viewed first
export async function loadAll(): Promise<IDBEntry[]> {
  const d = await getDb();
  return new Promise((resolve, reject) => {
    const req = d.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => {
      (req.result as IDBEntry[]).sort((a, b) => b.lastUpdated - a.lastUpdated);
      resolve(req.result as IDBEntry[]);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function save(entry: IDBEntry): Promise<void> {
  const d = await getDb();
  return new Promise((resolve, reject) => {
    const req = d.transaction(STORE, 'readwrite').objectStore(STORE).put(entry);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function saveMany(entries: IDBEntry[]): Promise<void> {
  if (!entries.length) return;
  const d = await getDb();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const e of entries) store.put(e);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function del(path: string): Promise<void> {
  const d = await getDb();
  return new Promise((resolve, reject) => {
    const req = d.transaction(STORE, 'readwrite').objectStore(STORE).delete(path);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function clearAll(): Promise<void> {
  const d = await getDb();
  return new Promise((resolve, reject) => {
    const req = d.transaction(STORE, 'readwrite').objectStore(STORE).clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
