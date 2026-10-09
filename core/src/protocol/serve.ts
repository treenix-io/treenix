import { randomBytes } from 'node:crypto'
import { KernelError } from '#errors'
import { tokenHash } from '#kernel/auth/crypto'
import type { AuthAdmission } from '#kernel/auth-factory'
import type { InstanceFoundationWithAuth } from '#kernel/instance'
import type { NodeLane, NodeLaneCommand } from '#kernel/lane'
export { networkAddress } from '#kernel/session-origin'
import type { CacheClaim, Credential, Request } from '#kernel/types'


interface ServedLane {
  readonly id: string
  readonly lane: NodeLane
  readonly admission: AuthAdmission
  readonly credentialHash: string
  readonly origin: string
  attached: boolean
  close(reason?: KernelError): void
}

function command(request: Request): NodeLaneCommand {
  switch (request.t) {
    case 'read':
      return { ...request, selector: request.selector }
    case 'sub': return request
    case 'commit':
      if (request.expect?.selectors?.some(input => 'history' in input.selector)) throw new KernelError('INVALID', 'Historical preconditions are not available on this binding')
      return request
    case 'cancel': case 'unsub': case 'act': return request
    default: throw new KernelError('INVALID', 'Unsupported lane command')
  }
}

export function createTwpServing(instance: InstanceFoundationWithAuth) {
  const lanes = new Map<string, ServedLane>()
  let closed = false
  function available(): void { if (closed) throw new KernelError('UNAVAILABLE', 'Serving is closed') }
  function authorized(id: string, credential: Credential | undefined, origin: string): ServedLane {
    available()
    const found = lanes.get(id)
    if (found === undefined || credential === undefined || tokenHash(credential.token) !== found.credentialHash || origin !== found.origin)
      throw new KernelError('UNAUTHENTICATED', 'Lane authorization failed')
    found.admission.assertActive()
    return found
  }
  return {
    /** Open a lane after validating the handshake and binding credentials. */
    async open(
      hi: Extract<Request, { t: 'hi' }>,
      credential: Credential | undefined,
      origin: string,
    ) {
      available();
      const limits = instance.limits();
      if (
        Buffer.byteLength(JSON.stringify(hi)) > limits.requestBytes ||
        (hi.cache?.length ?? 0) > limits.readNodes
      )
        throw new KernelError('BUDGET', 'Handshake budget exceeded');
      let cache: readonly CacheClaim[] | undefined;
      if (hi.cache !== undefined && hi.cache.length > 0) {
        const ids = new Set<string>();
        cache = hi.cache.map(claim => {
          if (ids.has(claim.id)) throw new KernelError('INVALID', 'Duplicate cache claim');
          ids.add(claim.id);
          return Object.freeze({ ...claim });
        });
      }

      if (
        hi.credential !== undefined &&
        credential !== undefined &&
        hi.credential.token !== credential.token
      )
        throw new KernelError('UNAUTHENTICATED', 'Conflicting credentials');
      const token = credential?.token ?? hi.credential?.token;
      const supplied = token === undefined ? undefined : { token };
      let admission: AuthAdmission | undefined;
      let session: NodeLane | undefined;
      try {
        const opened = await instance.sessionFactory.openCredential(supplied, origin, { cache });
        admission = opened.admission;
        session = opened.session;
        available();
        const bound = admission,
          issuedCredential = opened.issuedCredential;
        const effective = supplied ?? issuedCredential;
        if (effective === undefined)
          throw new KernelError('UNAVAILABLE', 'Auth factory did not issue a credential');
        const lane = session;
        bound.assertActive();
        const id = randomBytes(16).toString('hex');
        let ended = false;
        const onAbort = () => record.close();
        const record: ServedLane = {
          id,
          lane,
          admission: bound,
          origin,
          attached: false,
          credentialHash: tokenHash(effective.token),
          close(reason) {
            if (ended) return;
            ended = true;
            lanes.delete(id);
            bound.signal.removeEventListener('abort', onAbort);
            lane.close(reason);
            bound.close(reason);
          },
        };
        lanes.set(id, record);
        bound.signal.addEventListener('abort', onAbort, { once: true });
        bound.assertActive();
        return { id, ...(issuedCredential === undefined ? {} : { credential: issuedCredential }) };
      } catch (error) {
        session?.close();
        admission?.close();
        throw error;
      }
    },
    dispatch(id: string, credential: Credential | undefined, origin: string, requests: readonly Request[]): void {
      const found = authorized(id, credential, origin), decoded = requests.map(command)
      found.lane.touch()
      for (const request of decoded) found.lane.accept(request)
    },
    attach(id: string, credential: Credential | undefined, origin: string) {
      const found = authorized(id, credential, origin)
      if (found.attached) throw new KernelError('CONFLICT', 'Lane already has a reader')
      found.attached = true; found.lane.touch()
      return { frames: found.lane.frames, close: found.close }
    },
    close() {
      if (closed) return
      closed = true
      for (const record of lanes.values()) record.close()
    },
  }
}
export type TwpServing = ReturnType<typeof createTwpServing>
