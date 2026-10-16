import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { KernelError } from '#errors';
import type { LoginInput } from '#kernel/auth/login';
import type { InstanceFoundationWithAuth } from '#kernel/instance';
import type { Credential, Frame } from '#kernel/types';
import { createTwpServing, networkAddress } from '#protocol/serve';
import { decodeJson, decodeRequests, encodeFrame } from '#protocol/twp';
import {
  buildClearSessionCookie,
  buildSessionCookie,
  parseSessionCookie,
  sessionCookies,
} from '#security/cookies';
import { isRecord } from '#util/is-record';
import { assertSafePath } from '#core/path';
import { createTwpHttpRoutes, type TwpHttpRoutes } from '#server/http-routes';
import { createStaticHandler } from '#server/static';

export interface TwpHttpOptions {
  readonly instance: InstanceFoundationWithAuth;
  readonly allowedOrigins: readonly string[];
  readonly credentialTtlMs: number;
  readonly trustProxy?: boolean;
  readonly routes?: TwpHttpRoutes;
  readonly staticDir?: string;
}

function credentials(request: IncomingMessage): Credential | undefined {
  const authorization = request.headers.authorization,
    cookie = request.headers.cookie;
  const cookies = sessionCookies(cookie);
  if (cookies.length > 1) throw new KernelError('UNAUTHENTICATED', 'Conflicting session cookies');
  const token = parseSessionCookie(cookie);
  if (cookies.length === 1 && token === null)
    throw new KernelError('UNAUTHENTICATED', 'Empty session cookie');
  let bearer: string | undefined;
  if (authorization !== undefined) {
    if (!/^Bearer \S+$/.test(authorization))
      throw new KernelError('UNAUTHENTICATED', 'Malformed bearer credential');
    bearer = authorization.slice(7);
  }
  if (bearer !== undefined && token !== null && bearer !== token)
    throw new KernelError('UNAUTHENTICATED', 'Conflicting credentials');
  const supplied = bearer ?? token;
  return supplied === null ? undefined : { token: supplied };
}
function clientOrigin(request: IncomingMessage, trustProxy: boolean): string {
  const forwarded = trustProxy ? request.headers['x-forwarded-for'] : undefined;
  const address =
    forwarded === undefined
      ? request.socket.remoteAddress
      : (Array.isArray(forwarded) ? forwarded.join(',') : forwarded).split(',').at(-1)!.trim();
  if (address === undefined) throw new KernelError('INVALID', 'Network origin is absent');
  return networkAddress(address).address;
}
function login(input: unknown): LoginInput {
  if (
    !isRecord(input) ||
    Object.keys(input).some((key) => !['account', 'password', 'scope'].includes(key)) ||
    typeof input.account !== 'string' ||
    typeof input.password !== 'string'
  )
    throw new KernelError('INVALID', 'Malformed login');
  try {
    assertSafePath(input.account);
  } catch {
    throw new KernelError('INVALID', 'Invalid login address');
  }
  if (input.scope === undefined) return { account: input.account, password: input.password };
  if (!Array.isArray(input.scope)) throw new KernelError('INVALID', 'Malformed login scope');
  const scope: string[] = [];
  for (const item of input.scope) {
    if (typeof item !== 'string') throw new KernelError('INVALID', 'Malformed login scope');
    try {
      assertSafePath(item);
    } catch {
      throw new KernelError('INVALID', 'Invalid login scope');
    }
    scope.push(item);
  }
  return { account: input.account, password: input.password, scope };
}
async function body(request: IncomingMessage, limit: number): Promise<Buffer> {
  const contentType = request.headers['content-type'];
  if (contentType === undefined || !/^application\/json(?:\s*;|$)/i.test(contentType))
    throw new KernelError('INVALID', 'JSON content type is required');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const part: Buffer = chunk;
    bytes += part.byteLength;
    if (bytes > limit) throw new KernelError('BUDGET', 'HTTP request is too large');
    chunks.push(part);
  }
  return Buffer.concat(chunks, bytes);
}
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}
export async function writeSse(
  response: ServerResponse,
  frames: AsyncIterable<Frame>,
  signal: AbortSignal,
): Promise<void> {
  for await (const frame of frames) {
    signal.throwIfAborted();
    if (!response.write(`data: ${encodeFrame(frame)}\n\n`))
      await once(response, 'drain', { signal });
  }
}

export function createTwpHttpServer(input: TwpHttpOptions) {
  const { instance, credentialTtlMs, trustProxy = false } = input;
  if (!Number.isFinite(credentialTtlMs) || credentialTtlMs <= 0)
    throw new KernelError('INVALID', 'Credential lifetime must be positive');
  const allowedOrigins = Object.freeze([...input.allowedOrigins]),
    serving = createTwpServing(instance);
  const routes = (input.routes ?? createTwpHttpRoutes()).bind();
  const staticHandler =
    input.staticDir === undefined ? undefined : createStaticHandler(input.staticDir);
  const routeSessions = new Set<() => void>();
  let closing = false;
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const origin = request.headers.origin;
    if (origin !== undefined && !allowedOrigins.includes(origin))
      throw new KernelError('REFUSED', 'HTTP origin refused');
    if (origin !== undefined) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Access-Control-Allow-Credentials', 'true');
      response.setHeader('Vary', 'Origin');
    }
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, TWP-Lane, TWP-Path, TWP-Field',
    );
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    const url = new URL(request.url ?? '/', 'http://localhost');
    const route = routes.get(url.pathname);
    if (
      route === undefined &&
      !url.pathname.startsWith('/twp') &&
      !url.pathname.startsWith('/auth/') &&
      !url.pathname.startsWith('/api/') &&
      staticHandler !== undefined &&
      (await staticHandler(request, response, url.pathname))
    )
      return;
    const network = clientOrigin(request, trustProxy),
      credential = credentials(request);
    if (
      request.method === 'POST' &&
      request.headers.cookie !== undefined &&
      request.headers.authorization === undefined &&
      origin === undefined
    )
      throw new KernelError('REFUSED', 'Cookie requests need an allowed origin');
    if (route !== undefined) {
      route.signal.throwIfAborted();
      const supplied = await route.credential?.(request);
      if (supplied !== undefined && credential !== undefined && supplied.token !== credential.token)
        throw new KernelError('UNAUTHENTICATED', 'Conflicting credentials');
      route.signal.throwIfAborted();
      const opened = await instance.sessionFactory.openCredential(supplied ?? credential, network);
      const closed = () => opened.session.close(new KernelError('CANCELLED', 'HTTP route ended'));
      const disconnected = () => {
        if (!response.writableEnded) closed();
      };
      routeSessions.add(closed);
      request.once('aborted', closed);
      response.once('close', disconnected);
      route.signal.addEventListener('abort', closed, { once: true });
      try {
        if (closing || request.aborted || response.destroyed)
          throw new KernelError('CANCELLED', 'HTTP route ended before admission');
        route.signal.throwIfAborted();
        opened.admission.assertActive();
        if (opened.issuedCredential !== undefined)
          response.setHeader(
            'Set-Cookie',
            buildSessionCookie(opened.issuedCredential.token, Math.floor(credentialTtlMs / 1000)),
          );
        await route.handler(request, response, opened.session);
      } finally {
        routeSessions.delete(closed);
        request.removeListener('aborted', closed);
        response.removeListener('close', disconnected);
        route.signal.removeEventListener('abort', closed);
        closed();
      }
      return;
    }
    if (url.search !== '')
      throw new KernelError('INVALID', 'TWP does not accept query credentials or commands');
    if (request.method === 'POST' && url.pathname === '/auth/login') {
      const token = await instance.auth.login(
        login(
          decodeJson(
            await body(request, instance.limits().requestBytes),
            instance.limits().requestBytes,
          ),
        ),
      );
      response.setHeader(
        'Set-Cookie',
        buildSessionCookie(token.token, Math.floor(credentialTtlMs / 1000)),
      );
      json(response, 200, token);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/twp') {
      const requests = decodeRequests(
        await body(request, instance.limits().requestBytes),
        instance.limits().requestBytes,
      );
      const laneHeader = request.headers['twp-lane'];
      if (laneHeader === undefined) {
        if (requests.length !== 1 || requests[0].t !== 'hi')
          throw new KernelError('INVALID', 'Open with one hi request');
        const opened = await serving.open(requests[0], credential, network);
        if (opened.credential !== undefined)
          response.setHeader(
            'Set-Cookie',
            buildSessionCookie(opened.credential.token, Math.floor(credentialTtlMs / 1000)),
          );
        json(response, 201, {
          lane: opened.id,
          ...(opened.credential === undefined ? {} : { credential: opened.credential }),
        });
      } else {
        if (typeof laneHeader !== 'string')
          throw new KernelError('INVALID', 'Malformed lane header');
        serving.dispatch(laneHeader, credential, network, requests);
        json(response, 202, { accepted: true });
      }
      return;
    }
    if (url.pathname === '/twp/blob' && (request.method === 'POST' || request.method === 'GET')) {
      const lane = request.headers['twp-lane'];
      if (typeof lane !== 'string')
        throw new KernelError('INVALID', 'Binary transfer lane is absent');
      if (request.method === 'POST') {
        const type = request.headers['content-type'];
        if (typeof type !== 'string')
          throw new KernelError('INVALID', 'Blob content type is absent');
        async function* parts(): AsyncGenerator<Uint8Array> {
          for await (const chunk of request) {
            const part: Buffer = chunk;
            yield part;
          }
        }
        const controller = new AbortController();
        const disconnected = () => {
          if (!response.writableEnded)
            controller.abort(new KernelError('CANCELLED', 'Blob uploader disconnected'));
        };
        request.once('aborted', disconnected);
        response.once('close', disconnected);
        try {
          json(
            response,
            201,
            await serving.upload(lane, credential, network, parts(), type, controller.signal),
          );
        } finally {
          request.removeListener('aborted', disconnected);
          response.removeListener('close', disconnected);
        }
        return;
      }
      const path = request.headers['twp-path'],
        field = request.headers['twp-field'];
      if (typeof path !== 'string' || typeof field !== 'string')
        throw new KernelError('INVALID', 'Blob address is absent');
      assertSafePath(path);
      const controller = new AbortController();
      const iterator = serving
        .download(lane, credential, network, path, field, controller.signal)
        [Symbol.asyncIterator]();
      const disconnected = () =>
        controller.abort(new KernelError('CANCELLED', 'Blob reader disconnected'));
      response.once('close', disconnected);
      try {
        const first = await iterator.next();
        controller.signal.throwIfAborted();
        response.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        let next = first;
        while (!next.done) {
          controller.signal.throwIfAborted();
          if (!response.write(next.value))
            await once(response, 'drain', { signal: controller.signal });
          next = await iterator.next();
        }
        response.end();
      } finally {
        response.removeListener('close', disconnected);
        await iterator.return?.();
      }
      return;
    }
    const laneId = /^\/twp\/lane\/([0-9a-f]{32})$/.exec(url.pathname)?.[1];
    if (request.method === 'GET' && laneId !== undefined) {
      const attached = serving.attach(laneId, credential, network),
        controller = new AbortController();
      const disconnected = () => {
        controller.abort(new KernelError('CANCELLED', 'HTTP reader disconnected'));
        attached.close();
      };
      response.once('close', disconnected);
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff',
      });
      response.flushHeaders();
      try {
        await writeSse(response, attached.frames, controller.signal);
      } catch (error) {
        if (
          !(
            controller.signal.aborted &&
            (error === controller.signal.reason ||
              (error instanceof Error && error.name === 'AbortError'))
          )
        )
          throw error;
      } finally {
        response.removeListener('close', disconnected);
        attached.close();
        response.end();
      }
      return;
    }
    throw new KernelError('NOT_FOUND', 'HTTP route is absent');
  }
  const server = createServer(
    { maxHeaderSize: 16 * 1024, requestTimeout: 30_000, headersTimeout: 10_000 },
    (request, response) => {
      handle(request, response).catch((error: unknown) => {
        if (!(error instanceof KernelError)) console.error(error);
        if (response.headersSent) {
          response.destroy();
          return;
        }
        const failure =
          error instanceof KernelError
            ? error
            : new KernelError('UNAVAILABLE', 'HTTP request failed');
        if (failure.code === 'UNAUTHENTICATED')
          response.setHeader('Set-Cookie', buildClearSessionCookie());
        response.setHeader('Connection', 'close');
        request.resume();
        const status =
          failure.code === 'UNAUTHENTICATED'
            ? 401
            : failure.code === 'BUDGET'
              ? 413
              : failure.code === 'NOT_FOUND'
                ? 404
                : failure.code === 'REFUSED' || failure.code === 'FORBIDDEN'
                  ? 403
                  : failure.code === 'UNAVAILABLE'
                    ? 500
                    : 400;
        json(response, status, {
          t: 'fail',
          error: { code: failure.code, message: failure.message },
        });
      });
    },
  );
  return {
    server,
    async close(): Promise<void> {
      closing = true;
      routes.close();
      for (const close of routeSessions) close();
      serving.close();
      server.closeAllConnections();
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error === undefined ? resolve() : reject(error))),
        );
    },
  };
}
