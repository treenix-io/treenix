import type { ServerResponse } from 'node:http';
import { KernelError } from '@treenx/core/errors';
import { buildClearSessionCookie } from '@treenx/core/security';

/** A rejected session may load the public login shell, never private SSR state. */
export function recoverSsrAuthentication(error: unknown, response: ServerResponse): boolean {
  if (!(error instanceof KernelError) || error.code !== 'UNAUTHENTICATED') return false;
  console.warn('[front] Session rejected; returning login shell');
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'private, no-store',
    'Set-Cookie': buildClearSessionCookie(),
  });
  return true;
}
