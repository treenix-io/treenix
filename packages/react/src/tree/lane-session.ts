import { createLaneCache } from '@treenx/core/client/lane-cache';
import { openTwpHttp } from '@treenx/core/client/http-twp';
import { createTwpClient, type TwpClient } from '@treenx/core/client/twp';
import { KernelError } from '@treenx/core/errors';
import type { Credential } from '@treenx/core/kernel/types';
import { createLanePersistence } from '#tree/lane-idb';
import { createLaneTreeClient } from '#tree/lane-tree-client';
import { createLaneTreeSource } from '#tree/lane-source';

export type LaneSessionState =
  | { readonly status: 'login'; readonly error?: KernelError }
  | { readonly status: 'connecting' }
  | { readonly status: 'ready'; readonly source: ReturnType<typeof createLaneTreeSource> };

/** Own authenticated transport, canonical copies and durable admission under one principal lifetime. */
export function createLaneSession(url: string, persistence = createLanePersistence()) {
  const cache = createLaneCache();
  const listeners = new Set<() => void>();
  let generation = 0, closed = false;
  let state: LaneSessionState = { status: 'login' };
  let active: { close(): void } | undefined;
  let writes = Promise.resolve();

  function publish(next: LaneSessionState): void {
    state = next;
    for (const listener of listeners) listener();
  }

  /** Keep failed durable writes visible and stop treating the storage as authenticated. */
  const unsubscribe = cache.subscribePersisted(change => {
    const epoch = generation;
    writes = persistence.apply(change);
    void writes.catch(error => {
      console.error('[treenix] lane persistence failed', error);
      if (closed || epoch !== generation) return;
      active?.close();
      cache.clear();
      publish({ status: 'login', error: new KernelError('UNAVAILABLE', 'Durable cache failed') });
    });
  });

  /** Release all visible old-principal owners before any asynchronous identity transition. */
  function begin(): { epoch: number; wipe: Promise<void> } {
    if (closed) throw new KernelError('CANCELLED', 'Lane session is closed');
    const epoch = ++generation;
    active?.close();
    active = undefined;
    cache.clear();
    const wipe = persistence.wipe();
    publish({ status: 'connecting' });
    return { epoch, wipe };
  }

  /** Admit a client only while this exact transition still owns the session. */
  async function connect(epoch: number, credential?: Credential): Promise<void> {
    const current = () => !closed && epoch === generation;
    let admittedCredential = credential;
    async function transport() {
      if (!current()) throw new KernelError('CANCELLED', 'Identity transition was superseded');
      const connection = await openTwpHttp({ url, credential: admittedCredential, cache, credentials: admittedCredential === undefined ? 'omit' : undefined });
      if (!current()) { connection.close(); throw new KernelError('CANCELLED', 'Identity transition was superseded'); }
      return createTwpClient(connection, { credential: admittedCredential, cache, close: connection.close,
        onError(error) {
          if (!current() || error.code !== 'UNAUTHENTICATED') return;
          active?.close(); cache.clear();
          const wipe = persistence.wipe();
          publish({ status: 'login', error });
          void wipe.catch(received => console.error('[treenix] principal wipe failed', received));
        },
      });
    }
    let initial: TwpClient;
    try { initial = await transport(); }
    catch (error) {
      if (!current()) return;
      cache.clear();
      await persistence.wipe();
      if (!current()) return;
      if (!(error instanceof KernelError)) throw error;
      publish({ status: 'login', error });
      return;
    }
    const client = createLaneTreeClient(initial, { reconnect: transport });
    const source = createLaneTreeSource(client);
    active = { close() { source.close(); client.close(); } };
    try {
      const welcome = await client.ready;
      admittedCredential = welcome.credential ?? admittedCredential;
      if (!current()) { source.close(); client.close(); return; }
      await writes;
      if (current()) publish({ status: 'ready', source });
    } catch (error) {
      source.close(); client.close();
      if (!current()) return;
      cache.clear();
      await persistence.wipe();
      if (!current()) return;
      if (!(error instanceof KernelError)) throw error;
      publish({ status: 'login', error });
    }
  }

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    /** Credential-less hello uses the server's actual anonymous policy. */
    async anonymous() {
      const { epoch, wipe } = begin();
      await wipe;
      await connect(epoch);
    },
    async login(account: string, password: string) {
      const { epoch, wipe } = begin();
      await wipe;
      const response = await fetch(`${url.replace(/\/$/, '')}/auth/login`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account, password }),
      });
      if (!response.ok) {
        const error = new KernelError(response.status === 401 ? 'UNAUTHENTICATED' : 'UNAVAILABLE', 'Login refused');
        if (epoch === generation) publish({ status: 'login', error });
        return;
      }
      const raw: unknown = await response.json();
      if (typeof raw !== 'object' || raw === null || !('token' in raw) || typeof raw.token !== 'string' || raw.token.length === 0)
        throw new KernelError('INVALID', 'Malformed login credential');
      if (epoch === generation) await connect(epoch, { token: raw.token });
    },
    /** Restore invisible identity candidates before offering bounded claims to the actual server. */
    async restore(credential: Credential) {
      if (closed || active !== undefined) throw new KernelError('CONFLICT', 'Session already owns a lane');
      const epoch = ++generation;
      publish({ status: 'connecting' });
      const snapshot = await persistence.load(credential);
      if (epoch !== generation || closed) return;
      if (snapshot !== undefined) cache.admitPersisted(snapshot);
      await connect(epoch, credential);
    },
    close() {
      if (closed) return;
      closed = true; generation++;
      active?.close(); cache.clear(); unsubscribe();
      publish({ status: 'login' }); listeners.clear();
    },
  };
}
