import { MongoClient } from 'mongodb';

// Shared MongoClient pool — one client per URI, reused across mounts
const clientPool = new Map<
  string,
  { client: MongoClient; refCount: number; ready: Promise<MongoClient> }
>();

export function getSharedClient(
  uri: string,
  monitorCommands = false,
): { client: MongoClient; ready: Promise<MongoClient>; release: () => Promise<void> } {
  const key = monitorCommands ? JSON.stringify([uri, 'monitorCommands']) : uri;
  let entry = clientPool.get(key);
  if (!entry) {
    const client = monitorCommands
      ? new MongoClient(uri, { monitorCommands: true })
      : new MongoClient(uri);
    const ready = client.connect();
    entry = { client, refCount: 0, ready };
    clientPool.set(key, entry);
  }
  entry.refCount++;
  const release = async () => {
    const e = clientPool.get(key);
    if (!e) return;
    e.refCount--;
    if (e.refCount <= 0) {
      clientPool.delete(key);
      await e.client.close();
    }
  };
  return { client: entry.client, ready: entry.ready, release };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** _path regex for a getChildren scan. depth 1 = direct children; depth N = N levels. */
export function buildPattern(parent: string, depth: number): RegExp {
  const esc = escapeRegex(parent);
  const seg = '[^/]+';
  if (depth < 0) return parent === '/' ? /^\/.*$/ : new RegExp(`^${esc}/.+`); // -1 = all descendants
  if (depth === 1) return parent === '/' ? /^\/[^/]+$/ : new RegExp(`^${esc}/${seg}$`);
  return parent === '/'
    ? new RegExp(`^(/${seg}){1,${depth}}$`)
    : new RegExp(`^${esc}(/${seg}){1,${depth}}$`);
}
