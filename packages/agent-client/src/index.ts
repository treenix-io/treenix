import { openTwpHttp } from '@treenx/core/client/http-twp';
import { createTwpClient, type TwpClient } from '@treenx/core/client/twp';
import { KernelError } from '@treenx/core/errors';
import type { Credential, Principal } from '@treenx/core/kernel';
import { scopeAgentClient } from '#scoped-client';

export type AgentOpts =
  | { readonly url: string; readonly credential: Credential }
  | { readonly url: string; readonly path: string; readonly key: string };

export type ConnectResult =
  | { readonly status: 'pending' }
  | {
      readonly status: 'approved';
      readonly client: TwpClient;
      readonly credential: Credential;
      readonly principal: Principal;
    };

export interface WaitOpts {
  readonly timeout?: number;
  readonly signal?: AbortSignal;
}

/** Opens a real native client whose close releases its HTTP lane. */
async function openClient(url: string, credential?: Credential): Promise<TwpClient> {
  const connection = await openTwpHttp({ url, credential, credentials: 'omit' });
  const client = createTwpClient(connection, { credential, close: connection.close });
  try {
    await client.ready;
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}

/** Decode the pairing action's published result at the SDK's wire boundary. */
function pairingResult(
  value: unknown,
):
  | { readonly status: 'pending' }
  | {
      readonly status: 'approved';
      readonly credential: Credential;
      readonly principal: Principal;
    } {
  if (typeof value !== 'object' || value === null || !('status' in value))
    throw new KernelError('INVALID', 'Malformed pairing result');
  if (value.status === 'pending') return { status: 'pending' };
  if (
    value.status !== 'approved' ||
    !('credential' in value) ||
    !('principal' in value) ||
    typeof value.principal !== 'string' ||
    !value.principal.startsWith('u:') ||
    typeof value.credential !== 'object' ||
    value.credential === null ||
    !('token' in value.credential) ||
    typeof value.credential.token !== 'string'
  )
    throw new KernelError('INVALID', 'Malformed approved pairing result');
  const principal: Principal = `u:${value.principal.slice(2)}`;
  return { status: 'approved', credential: { token: value.credential.token }, principal };
}

/** Connect through an issued credential or the port's native pairing action. */
export function createAgentClient(opts: AgentOpts) {
  const config: AgentOpts =
    'credential' in opts
      ? { url: opts.url, credential: Object.freeze({ ...opts.credential }) }
      : { url: opts.url, path: opts.path, key: opts.key };

  /** Replace the pairing lane with the approved account's authenticated lane. */
  async function approve(
    result: Extract<ReturnType<typeof pairingResult>, { status: 'approved' }>,
  ): Promise<Extract<ConnectResult, { status: 'approved' }>> {
    const opened = await openClient(config.url, result.credential);
    const client = 'path' in config ? scopeAgentClient(opened, config.path) : opened;
    return { ...result, client };
  }

  /** Perform one native connection attempt and release the temporary pairing lane. */
  async function connect(): Promise<ConnectResult> {
    if ('credential' in config) {
      const client = await openClient(config.url, config.credential);
      const welcome = await client.ready;
      return {
        status: 'approved',
        client,
        credential: config.credential,
        principal: welcome.principal,
      };
    }
    const client = await openClient(config.url);
    try {
      const result = pairingResult(
        (
          await client.act({ path: config.path, action: 'connect', args: { key: config.key } })
            .outcome
        ).value,
      );
      return result.status === 'pending' ? result : await approve(result);
    } finally {
      client.close();
    }
  }

  /** Wait on the port's native subscription until an operator approves pairing. */
  async function waitForApproval(options: WaitOpts = {}): Promise<TwpClient> {
    if ('credential' in config) {
      const result = await connect();
      if (result.status !== 'approved')
        throw new KernelError('INVALID', 'Credential connection stayed pending');
      return result.client;
    }
    const deadline = AbortSignal.timeout(options.timeout ?? 5 * 60 * 1000);
    const signal =
      options.signal === undefined ? deadline : AbortSignal.any([deadline, options.signal]);
    signal.throwIfAborted();
    const client = await openClient(config.url);
    try {
      const result = pairingResult(
        (
          await client.act(
            { path: config.path, action: 'connect', args: { key: config.key } },
            signal,
          ).outcome
        ).value,
      );
      if (result.status === 'approved') {
        const approved = await approve(result);
        if (approved.status !== 'approved')
          throw new KernelError('INVALID', 'Approved connection stayed pending');
        return approved.client;
      }
      const path = config.path;
      let subscription: ReturnType<TwpClient['sub']> | undefined;
      let aborted: () => void = () => {};
      await new Promise<void>((resolve, reject) => {
        /** Inspect only accepted subscription state; no retry timer reads the server. */
        function changed(): void {
          const copy = client.cache.at(path);
          if (copy === undefined) return;
          if ('error' in copy) {
            reject(copy.error);
            return;
          }
          if (copy.node.status === 'approved') resolve();
          else if (copy.node.status === 'revoked' || copy.node.status === 'idle')
            reject(new KernelError('FORBIDDEN', 'Agent pairing ended'));
        }
        aborted = () => reject(signal.reason);
        signal.addEventListener('abort', aborted, { once: true });
        subscription = client.sub({ node: path }, changed, reject);
        subscription.ready.then(changed, reject);
        signal.throwIfAborted();
      }).finally(() => {
        signal.removeEventListener('abort', aborted);
        subscription?.close();
      });
      const approved = pairingResult(
        (
          await client.act(
            { path: config.path, action: 'connect', args: { key: config.key } },
            signal,
          ).outcome
        ).value,
      );
      if (approved.status !== 'approved')
        throw new KernelError('CONFLICT', 'Agent approval changed');
      const connection = await approve(approved);
      if (connection.status !== 'approved')
        throw new KernelError('INVALID', 'Approved connection stayed pending');
      return connection.client;
    } finally {
      client.close();
    }
  }

  return { connect, waitForApproval };
}

export type { TwpClient } from '@treenx/core/client/twp';
