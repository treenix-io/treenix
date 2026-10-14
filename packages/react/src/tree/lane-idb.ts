import {
  DEFAULT_LIMITS,
  type Credential,
  type NodeCopy,
  type Principal,
} from '@treenx/core/kernel/types';
import type { PersistedLaneChange, PersistedLaneCopies } from '@treenx/core/client/lane-cache';
import { decodeFrame } from '@treenx/core/protocol/twp';
import { KernelError } from '@treenx/core/errors';

export interface LanePersistenceLimits {
  readonly readNodes: number;
  readonly readBytes: number;
}

/** Preserve normative error data because IndexedDB cloning loses custom Error subclass properties. */
function storedCopy(copy: NodeCopy): NodeCopy {
  return 'error' in copy
    ? { ...copy, error: { code: copy.error.code, message: copy.error.message } }
    : copy;
}

/** Resolve only after the complete transaction commits, including its metadata and payload rows. */
function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new KernelError('UNAVAILABLE', 'IndexedDB transaction aborted'));
    transaction.onerror = () => reject(transaction.error);
  });
}

/** Read an external IndexedDB value without pretending its stored shape is already trusted. */
function result(request: IDBRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Own one durable authenticated cache; all writes are ordered behind principal wipes. */
export function createLanePersistence(
  name = 'treenix-lane',
  limits: LanePersistenceLimits = DEFAULT_LIMITS,
) {
  let database: Promise<IDBDatabase> | undefined;
  let generation = 0;
  let tail = Promise.resolve();
  let owner: { readonly principal: Principal; readonly credential: Credential } | undefined;

  /** Open independent native stores, preserving the existing legacy path-keyed cache. */
  function open(): Promise<IDBDatabase> {
    if (database === undefined)
      database = new Promise((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('owner');
          request.result.createObjectStore('metadata');
          request.result.createObjectStore('copies', { keyPath: 'id' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    return database;
  }

  /** Stop stale producers synchronously, then clear durable rows before any later admission or write. */
  function wipe(): Promise<void> {
    generation++;
    owner = undefined;
    const prior = tail;
    tail = prior
      .catch((error) => {
        console.error('[treenix] failed persistence write before wipe', error);
      })
      .then(async () => {
        const db = await open();
        const transaction = db.transaction(['owner', 'metadata', 'copies'], 'readwrite');
        const done = completed(transaction);
        for (const store of ['owner', 'metadata', 'copies']) transaction.objectStore(store).clear();
        await done;
      });
    return tail;
  }

  /** Stage only changed identities; an old queued producer cannot repopulate a newly authenticated cache. */
  function apply(change: PersistedLaneChange): Promise<void> {
    if (change.kind === 'owner') {
      if (change.credential === undefined) return wipe();
      if (
        owner?.principal !== change.principal ||
        owner.credential.token !== change.credential.token
      )
        wipe();
      owner = { principal: change.principal, credential: change.credential };
    } else if (
      owner?.principal !== change.principal ||
      owner.credential.token !== change.credential.token
    ) {
      throw new KernelError('UNAUTHENTICATED', 'Persistence change belongs to another principal');
    }

    const epoch = generation;
    const prior = tail;
    tail = prior.then(async () => {
      if (epoch !== generation) return;
      const db = await open();
      if (epoch !== generation) return;
      const transaction = db.transaction(['owner', 'metadata', 'copies'], 'readwrite');
      const done = completed(transaction);
      if (change.kind === 'owner') {
        transaction.objectStore('owner').put(
          {
            t: 'welcome',
            principal: change.principal,
            credential: change.credential,
            intake: 'persisted',
          },
          'current',
        );
      } else {
        for (const [id, copy] of change.changes) {
          if (copy === null) {
            transaction.objectStore('metadata').delete(id);
            transaction.objectStore('copies').delete(id);
          } else {
            const stored = storedCopy(copy);
            const bytes = new TextEncoder().encode(JSON.stringify(stored)).byteLength;
            transaction.objectStore('metadata').put(bytes, id);
            transaction.objectStore('copies').put({ id, copy: stored });
          }
        }
      }
      await done;
    });
    return tail;
  }

  /** Precharge metadata before loading each payload, then decode the external durable data loudly. */
  async function load(credential: Credential): Promise<PersistedLaneCopies | undefined> {
    const epoch = generation;
    await tail;
    if (epoch !== generation) return undefined;
    const db = await open();
    if (epoch !== generation) return undefined;
    const transaction = db.transaction(['owner', 'metadata', 'copies'], 'readonly');
    const done = completed(transaction);
    const raw = await result(transaction.objectStore('owner').get('current'));
    if (epoch !== generation) {
      await done;
      return undefined;
    }
    if (raw === undefined) {
      await done;
      return undefined;
    }
    const welcome = decodeFrame(JSON.stringify(raw), limits.readBytes);
    if (welcome.t !== 'welcome' || welcome.credential === undefined)
      throw new KernelError('INVALID', 'Malformed persisted owner');
    if (welcome.credential.token !== credential.token) {
      await done;
      if (epoch === generation) await wipe();
      return undefined;
    }

    const copies: NodeCopy[] = [];
    let bytes = 0;
    const cursor = transaction.objectStore('metadata').openCursor();
    await new Promise<void>((resolve, reject) => {
      cursor.onerror = () => reject(cursor.error);
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (row === null || copies.length >= limits.readNodes) {
          resolve();
          return;
        }
        const size: unknown = row.value;
        if (
          typeof row.key !== 'string' ||
          typeof size !== 'number' ||
          !Number.isSafeInteger(size) ||
          size < 0
        ) {
          reject(new KernelError('INVALID', 'Malformed persisted metadata'));
          return;
        }
        if (bytes + size > limits.readBytes) {
          resolve();
          return;
        }
        bytes += size;
        const request = transaction.objectStore('copies').get(row.key);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          try {
            const stored: unknown = request.result;
            if (typeof stored !== 'object' || stored === null || !('copy' in stored))
              throw new KernelError('INVALID', 'Missing persisted copy');
            const frame = decodeFrame(
              JSON.stringify({
                t: 'snap',
                sub: 'persisted',
                gen: 1,
                list: [],
                copies: [stored.copy],
                at: [],
              }),
              limits.readBytes + 128,
            );
            if (frame.t !== 'snap' || frame.copies.length !== 1)
              throw new KernelError('INVALID', 'Malformed persisted copy');
            const copy = frame.copies[0];
            const id = 'node' in copy ? copy.node.$id : copy.id;
            if (
              id !== row.key ||
              new TextEncoder().encode(JSON.stringify(copy)).byteLength !== size
            )
              throw new KernelError('INVALID', 'Persisted identity or byte accounting differs');
            copies.push(copy);
            row.continue();
          } catch (error) {
            reject(error);
          }
        };
      };
    });
    await done;
    if (epoch !== generation) return undefined;
    owner = { principal: welcome.principal, credential };
    return { principal: welcome.principal, credential, copies };
  }

  return { apply, load, wipe, flushed: () => tail };
}
