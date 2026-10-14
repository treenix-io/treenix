import { KernelError } from '#errors';
import { isPrivateHost } from '#kernel/authority/host';
import { componentEntries } from '#kernel/migrate';
import type {
  Credential,
  FederationBinding,
  Limits,
  MountHandler,
  OpenedFederationConnection,
  Session,
} from '#kernel/types';

interface CredentialImage {
  readonly id: string;
  readonly rev: string;
  readonly ver: string;
  readonly credential: Credential;
}

/** Read the closed node through the declaring node's actual admitted session. */
async function credentialImage(session: Session, path: string): Promise<CredentialImage> {
  const result = await session.read({ node: path });
  const copy = result.copies.find((copy) =>
    'node' in copy ? copy.node.$path === path : copy.path === path,
  );
  if (copy === undefined)
    throw new KernelError('NOT_FOUND', 'Federation credential is unavailable');
  if (!('node' in copy)) throw copy.error;
  const node = copy.node;
  if (
    node.$type !== 't.outbound-credential' ||
    typeof node.token !== 'string' ||
    node.token.length === 0
  )
    throw new KernelError('INVALID', 'Malformed closed federation credential');
  return { id: node.$id, rev: node.$rev, ver: copy.ver, credential: { token: node.token } };
}

/** Each opened connection retains its own closed-node generation and transport release. */
export function createFederationMountHandler(
  binding: FederationBinding | undefined,
  limits: (() => Limits) | undefined,
): MountHandler {
  return async (node, session, component) => {
    if (session.actor.principal !== `n:${node.$id}`)
      throw new KernelError('FORBIDDEN', 'Federation mount requires its declaring node session');
    const declaration = componentEntries(node).find(([name]) => name === component);
    if (declaration === undefined)
      throw new KernelError('INVALID', 'Federation component is absent');
    const value = declaration[1];
    if (
      typeof value.url !== 'string' ||
      typeof value.credential !== 'string' ||
      !value.credential.startsWith('/')
    )
      throw new KernelError('INVALID', 'Malformed federation declaration');
    if (!URL.canParse(value.url)) throw new KernelError('INVALID', 'Invalid federation URL');
    const url = new URL(value.url);
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username !== '' ||
      url.password !== ''
    )
      throw new KernelError('INVALID', 'Federation URL must not contain credentials');
    if (value.allowPrivate !== true && isPrivateHost(url.hostname))
      throw new KernelError('INVALID', 'Private federation host requires explicit permission');
    if (binding === undefined || limits === undefined)
      throw new KernelError('UNAVAILABLE', 'Federation transport capability is unavailable');
    const openTransport = binding;
    const currentLimits = limits;
    const path = value.credential;
    const connections = new Set<OpenedFederationConnection>();
    const releases = new Set<() => Promise<void>>();
    let closed = false;
    let reading: Promise<CredentialImage> | undefined;
    function readCurrent(): Promise<CredentialImage> {
      if (reading !== undefined) return reading;
      const pending = credentialImage(session, path).finally(() => {
        reading = undefined;
      });
      reading = pending;
      return pending;
    }

    async function acquire(
      image: CredentialImage,
      signal?: AbortSignal,
    ): Promise<OpenedFederationConnection> {
      signal?.throwIfAborted();
      if (closed) throw new KernelError('CANCELLED', 'Federation target is closed');
      const transport = await openTransport(url.href, currentLimits);
      let released: Promise<void> | undefined;
      let opened: OpenedFederationConnection | undefined;
      const close = () =>
        (released ??= Promise.resolve().then(async () => {
          if (opened !== undefined) connections.delete(opened);
          try {
            await transport.close();
          } finally {
            releases.delete(close);
          }
        }));
      releases.add(close);
      const abort = () => {
        void close().catch((error) => console.error(error));
      };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        signal?.throwIfAborted();
        if (closed) throw new KernelError('CANCELLED', 'Federation target is closed');
        const connection = await transport.authority.connect(image.credential);
        if (closed) throw new KernelError('CANCELLED', 'Federation target is closed');
        opened = {
          send: (request) => connection.send(request),
          frames: connection.frames,
          close,
          async check() {
            try {
              if (closed || released !== undefined)
                throw new KernelError('CANCELLED', 'Federation connection is closed');
              const current = await readCurrent();
              if (
                current.id !== image.id ||
                current.rev !== image.rev ||
                current.ver !== image.ver ||
                current.credential.token !== image.credential.token
              )
                throw new KernelError(
                  'UNAUTHENTICATED',
                  'Federation credential generation changed',
                );
              if (closed || released !== undefined)
                throw new KernelError('CANCELLED', 'Federation connection is closed');
            } catch (error) {
              await close();
              throw error;
            }
          },
        };
        connections.add(opened);
        await opened.check();
        return opened;
      } catch (error) {
        await close();
        throw error;
      } finally {
        signal?.removeEventListener('abort', abort);
      }
    }

    return {
      kind: 'authority',
      authority: {
        kind: 'federation',
        async connect(credential) {
          const image = await readCurrent();
          if (credential.token !== image.credential.token)
            throw new KernelError(
              'UNAUTHENTICATED',
              'Federation credential does not match the closed node',
            );
          return acquire(image);
        },
        async open(signal) {
          signal?.throwIfAborted();
          return acquire(await readCurrent(), signal);
        },
      },
      async close() {
        closed = true;
        const results = await Promise.allSettled([...releases].map((release) => release()));
        releases.clear();
        connections.clear();
        const errors: unknown[] = [];
        for (const result of results)
          if (result.status === 'rejected') {
            console.error(result.reason);
            errors.push(result.reason);
          }
        if (errors.length !== 0)
          throw new AggregateError(errors, 'Federation connection release failed');
      },
    };
  };
}
