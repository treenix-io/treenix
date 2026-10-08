import { KernelError } from '#errors'
import type { AuthAdmission, AuthFactory } from '#kernel/auth-factory'
import { createNodeLane, type NodeLane, type NodeLaneOptions } from '#kernel/lane'
import { networkAddress } from '#kernel/session-origin'
import type { Credential, Limits, Path } from '#kernel/types'

export interface OpenedSession {
  readonly session: NodeLane
  readonly admission: AuthAdmission
  readonly issuedCredential?: Credential
}

export interface SessionFactoryOptions {
  readonly auth: AuthFactory
  readonly limits: () => Limits
  readonly lane: (admission: AuthAdmission) => NodeLaneOptions
}

/** Opens both authentication doors into the same native lane and owns their lifetime and quota. */
export function createSessionFactory(options: SessionFactoryOptions) {
  const sessions = new Set<NodeLane>();
  const buckets = new Map<string, number>();
  let opening = 0;
  let closed = false;

  /** Refuses opens after the owning instance has ended. */
  function available(): void {
    if (closed) throw new KernelError('UNAVAILABLE', 'Session factory is closed');
  }

  /** Reserves admission before asynchronous auth and publishes only an active constructed lane. */
  async function open(
    resolve: () => Promise<AuthAdmission>,
    issueCredential: boolean,
  ): Promise<OpenedSession> {
    available();
    if (sessions.size + opening >= options.limits().maxLanes)
      throw new KernelError('BUDGET', 'Lane limit reached');
    opening++;
    let admission: AuthAdmission | undefined;
    let session: NodeLane | undefined;

    try {
      admission = await resolve();
      available();
      const bound = admission;
      const bucket = bound.actor.principal.startsWith('anon:')
        ? `ip:${bound.origin === undefined ? 'local' : networkAddress(bound.origin).bucket}`
        : bound.actor.principal;
      const count = buckets.get(bucket) ?? 0;
      if (count >= options.limits().lanesPerOrigin)
        throw new KernelError('BUDGET', 'Origin lane limit reached');
      const issuedCredential = issueCredential ? bound.resolution.credential : undefined;
      session = createNodeLane({ ...options.lane(bound), issuedCredential });
      bound.assertActive();
      const owned = session;

      /** Release this lane's quota once its admission or session ends. */
      function released(): void {
        if (!sessions.delete(owned)) return;
        const remaining = buckets.get(bucket)! - 1;
        if (remaining === 0) buckets.delete(bucket);
        else buckets.set(bucket, remaining);
        bound.signal.removeEventListener('abort', released);
      }

      sessions.add(owned);
      buckets.set(bucket, count + 1);
      bound.signal.addEventListener('abort', released, { once: true });
      bound.assertActive();
      return {
        session: owned,
        admission: bound,
        ...(issuedCredential === undefined ? {} : { issuedCredential }),
      };
    } catch (error) {
      session?.close();
      admission?.close();
      throw error;
    } finally {
      opening--;
    }
  }

  return {
    /** Open an authenticated session, issuing a credential when the caller is anonymous. */
    openCredential(credential?: Credential, origin?: string): Promise<OpenedSession> {
      return open(() => options.auth.openCredential(credential, origin), credential === undefined);
    },
    /** Open a session authorized for one node path without issuing a credential. */
    openNode(path: Path): Promise<OpenedSession> {
      return open(() => options.auth.openNode(path), false);
    },
    /** Close active sessions and refuse future opens. */
    close(): void {
      if (closed) return;
      closed = true;
      for (const session of sessions) session.close();
    },
  };
}

export type SessionFactory = ReturnType<typeof createSessionFactory>
