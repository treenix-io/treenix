import type { IncomingMessage, ServerResponse } from 'node:http';
import { KernelError } from '@treenx/core/errors';
import { openTwpHttp } from '@treenx/core/client/http-twp';
import { createTwpClient } from '@treenx/core/client/twp';
import { parseSessionCookie, sessionCookies } from '@treenx/core/security';

/** Bind route discovery and rendering to this request's credential and cancellation. */
export async function openSsrSession(
  url: string,
  request: IncomingMessage,
  response: ServerResponse,
) {
  const controller = new AbortController();
  const abort = () => controller.abort(new KernelError('CANCELLED', 'SSR request ended'));
  const disconnect = () => {
    if (!response.writableEnded) abort();
  };
  request.once('aborted', abort);
  response.once('close', disconnect);
  const headers: Record<string, string> = {};
  for (const name of ['authorization', 'origin']) {
    const value = request.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }
  const cookies = sessionCookies(request.headers.cookie);
  if (cookies.length > 0) headers.cookie = cookies.join(';');
  const token = headers.authorization === undefined ? parseSessionCookie(headers.cookie) : null;
  let closeTransport: (() => void) | undefined;
  function close() {
    closeTransport?.();
    abort();
    request.off('aborted', abort);
    response.off('close', disconnect);
  }
  try {
    const connection = await openTwpHttp({
      url,
      headers,
      // SSR authenticates its own POST; ordinary browser navigation has no Origin header.
      credential: token === null ? undefined : { token },
      signal: controller.signal,
      credentials: headers.cookie === undefined ? 'omit' : 'include',
    });
    const client = createTwpClient(connection, { close: connection.close });
    closeTransport = () => client.close();
    await client.ready;
    return {
      reader: client,
      private: headers.cookie !== undefined || headers.authorization !== undefined,
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}
