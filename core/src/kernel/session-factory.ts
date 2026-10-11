import { KernelError } from '#errors'
import type { AuthAdmission, AuthFactory } from '#kernel/auth-factory'
import { createNodeLane, type NodeLane, type NodeLaneOptions } from '#kernel/lane'
import { networkAddress } from '#kernel/session-origin'
import type { Credential, Limits, Path, RightsPrefix, ShardEnvelope } from '#kernel/types'
import type { AcceptedNodeRead } from '#kernel/writer'

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

/** Controls idle expiry for a node session whose lifetime is owned by the kernel. */
export type NodeSessionOptions = Pick<NodeLaneOptions, 'heartbeat'>

export interface NodeSessionReservation {
  validate(): void
  open(owner: AcceptedNodeRead, options?: NodeSessionOptions): Promise<OpenedSession>
  close(): void
}
interface NodeQuota {
  readonly principal: string
  validate(): void
  release(): void
}

/** Opens both authentication doors into the same native lane and owns their lifetime and quota. */
export function createSessionFactory(options: SessionFactoryOptions) {
  const sessions = new Set<NodeLane>();
  const buckets = new Map<string, number>();
  const reservedBuckets = new Map<string, number>();
  const reservations = new Set<NodeQuota>();
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
    heartbeat = true,
    cache?: NodeLaneOptions['cache'],
    quota?: NodeQuota,
  ): Promise<OpenedSession> {
    available();
    if (quota === undefined) {
      if (sessions.size + opening >= options.limits().maxLanes)
        throw new KernelError('BUDGET', 'Lane limit reached');
      opening++;
    } else quota.validate();
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
      if (quota !== undefined) {
        quota.validate();
        if (bucket !== quota.principal) throw new KernelError('INVALID', 'Reserved executor identity differs');
      }
      if (count + (reservedBuckets.get(bucket) ?? 0) - (quota === undefined ? 0 : 1) >= options.limits().lanesPerOrigin)
        throw new KernelError('BUDGET', 'Origin lane limit reached');
      const issuedCredential = issueCredential ? bound.resolution.credential : undefined;
      session = createNodeLane({ ...options.lane(bound), issuedCredential, heartbeat, cache });
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
      if (quota === undefined) opening--;
      else quota.release();
    }
  }

  return {
    /** Uses the same lane admission, quota and owned lifetime as local sessions. */
    async openShard(envelope: ShardEnvelope) {
      const accepted = options.auth.openShard(envelope)
      try {
        const opened = await open(() => Promise.resolve(accepted.admission), false, false)
        return { ...opened, update(prefix: RightsPrefix) { accepted.update(prefix); opened.session.rightsChanged() } }
      } catch (error) { accepted.admission.close(); throw error }
    },
    /** Reserve the exact future executor's lane before its canonical declaration becomes durable. */
    reserveNode(path: Path, id: string): NodeSessionReservation {
      available();
      const principal = `n:${id}`;
      if (sessions.size + opening >= options.limits().maxLanes
        || (buckets.get(principal) ?? 0) + (reservedBuckets.get(principal) ?? 0) >= options.limits().lanesPerOrigin)
        throw new KernelError('BUDGET', 'Node session quota is exhausted');
      opening++;
      reservedBuckets.set(principal, (reservedBuckets.get(principal) ?? 0) + 1);
      let active = true, used = false;
      const quota: NodeQuota = {
        principal,
        validate() {
          available();
          if (!active) throw new KernelError('UNAVAILABLE', 'Node session reservation ended');
          if (sessions.size + opening > options.limits().maxLanes
            || (buckets.get(principal) ?? 0) + reservedBuckets.get(principal)! > options.limits().lanesPerOrigin)
            throw new KernelError('BUDGET', 'Node session quota changed');
        },
        release() {
          if (!active) return;
          active = false;
          reservations.delete(quota);
          opening--;
          const remaining = reservedBuckets.get(principal)! - 1;
          if (remaining === 0) reservedBuckets.delete(principal);
          else reservedBuckets.set(principal, remaining);
        },
      };
      reservations.add(quota);
      return {
        validate: quota.validate,
        open(owner, sessionOptions = {}) {
          quota.validate();
          if (used || owner.path !== path || owner.id !== id)
            throw new KernelError('INVALID', 'Accepted owner differs from its reserved node session');
          used = true;
          return open(() => options.auth.openNodeIn(owner), false, sessionOptions.heartbeat !== false, undefined, quota);
        },
        close: quota.release,
      };
    },
    /** Open an authenticated session, issuing a credential when the caller is anonymous. */
    openCredential(
      credential?: Credential,
      origin?: string,
      sessionOptions: Pick<NodeLaneOptions, 'cache'> = {},
    ): Promise<OpenedSession> {
      return open(
        () => options.auth.openCredential(credential, origin),
        credential === undefined,
        true,
        sessionOptions.cache,
      )
    },
    /** Opens a node-authorized lane; kernel owners may disable its network idle expiry. */
    openNode(path: Path, sessionOptions: NodeSessionOptions = {}): Promise<OpenedSession> {
      return open(() => options.auth.openNode(path), false, sessionOptions.heartbeat !== false);
    },
    /** Gives new lanes a fresh welcome while accepted requests finish on their original lane. */
    reconnect(): void {
      for (const session of sessions) session.reconnect()
    },
    /** Close active sessions and refuse future opens. */
    close(): void {
      if (closed) return;
      closed = true;
      for (const reservation of reservations) reservation.release();
      for (const session of sessions) session.close();
    },
  };
}

export type SessionFactory = ReturnType<typeof createSessionFactory>
