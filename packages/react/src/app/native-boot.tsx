import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { openTwpHttp } from '@treenx/core/client/http-twp';
import { createTwpClient } from '@treenx/core/client/twp';
import { createLaneCache } from '@treenx/core/client/lane-cache';
import { KernelError } from '@treenx/core/errors';
import { isReadResult, isSelector } from '@treenx/core/protocol/twp';
import { NativeRouter } from '#app/NativeRouter';
import { createLaneTreeSource } from '#tree/lane-source';
import { createLaneTreeClient } from '#tree/lane-tree-client';
import type { NativeHydrationState } from '#tree/read-snapshot';
import { TreeSourceProvider } from '#tree/tree-source-context';
import { AuthProvider, type AuthPort, type AuthState } from '#app/auth-context';
import type { Credential } from '@treenx/core/kernel/types';
import { TooltipProvider } from '#components/ui/tooltip';
import { Toaster } from '#components/ui/sonner';

/** Decode external HTML hydration at its boundary, retaining actual selectors and native results. */
export function decodeNativeHydration(value: unknown): NativeHydrationState {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('reads' in value) ||
    !Array.isArray(value.reads)
  )
    throw new KernelError('INVALID', 'Malformed native hydration');
  const reads: NativeHydrationState['reads'][number][] = [];
  for (const read of value.reads) {
    if (
      typeof read !== 'object' ||
      read === null ||
      !('selector' in read) ||
      !isSelector(read.selector) ||
      'history' in read.selector ||
      !('result' in read) ||
      !isReadResult(read.result)
    )
      throw new KernelError('INVALID', 'Malformed native hydration read');
    reads.push({ selector: read.selector, result: read.result });
  }
  return { reads };
}

/** Replace server presentation with one genuinely admitted native lane. */
export async function bootNative(root: HTMLElement, initial: NativeHydrationState) {
  const tokenKey = 'treenix.native.token';
  const saved = sessionStorage.getItem(tokenKey);
  let mounted: ReturnType<typeof createRoot> | undefined;
  let release = () => {};
  let principal: string | null = null;
  let showLoginModal = false;
  let paint = () => {};
  const auth: AuthState = {
    get authed() {
      return principal;
    },
    authChecked: true,
    get showLoginModal() {
      return showLoginModal;
    },
    setAuthed(uid) {
      if (uid !== principal)
        throw new KernelError('INVALID', 'Login principal differs from accepted lane');
      paint();
    },
    closeLoginModal() {
      showLoginModal = false;
      paint();
    },
    logout() {
      sessionStorage.removeItem(tokenKey);
      showLoginModal = true;
      void replace(undefined, { reads: [] }).catch((error) => {
        console.error('[treenix] logout failed', error);
        root.textContent = error instanceof Error ? error.message : String(error);
      });
    },
  };
  const port: AuthPort = {
    async login(userId, password) {
      const response = await fetch('/auth/login', {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: userId.startsWith('/') ? userId : `/${userId}`, password }),
      });
      const value: unknown = await response.json();
      if (!response.ok) throw new Error(`Login refused (${response.status})`);
      if (
        typeof value !== 'object' ||
        value === null ||
        !('token' in value) ||
        typeof value.token !== 'string'
      )
        throw new KernelError('INVALID', 'Malformed login credential');
      await replace({ token: value.token }, { reads: [] });
      sessionStorage.setItem(tokenKey, value.token);
      if (principal === null)
        throw new KernelError('UNAUTHENTICATED', 'Login opened an anonymous lane');
      return { userId: principal };
    },
  };
  async function replace(credential: Credential | undefined, hydration: NativeHydrationState) {
    const cache = createLaneCache();
    let admittedCredential = credential;
    async function transport() {
      const connection = await openTwpHttp({
        url: window.location.origin,
        credentials: 'omit',
        credential: admittedCredential,
        cache,
      });
      return createTwpClient(connection, {
        credential: admittedCredential,
        cache,
        close: connection.close,
      });
    }
    const initial = await transport();
    const client = createLaneTreeClient(initial, { reconnect: transport });
    let welcome;
    try {
      welcome = await client.ready;
    } catch (error) {
      client.close();
      throw error;
    }
    admittedCredential = welcome.credential ?? admittedCredential;
    const source = createLaneTreeSource(client, hydration);
    release();
    release = () => {
      source.close();
      client.close();
    };
    principal = welcome.principal.startsWith('anon:') ? null : welcome.principal;
    const queryClient = new QueryClient();
    const tree = () => (
      <AuthProvider value={{ ...auth }} port={port}>
        <TreeSourceProvider source={source}>
          <QueryClientProvider client={queryClient}>
            <TooltipProvider delayDuration={300}>
              <NativeRouter />
              <Toaster />
            </TooltipProvider>
          </QueryClientProvider>
        </TreeSourceProvider>
      </AuthProvider>
    );
    const hydrate = mounted === undefined && root.firstElementChild !== null;
    if (mounted === undefined) mounted = hydrate ? hydrateRoot(root, tree()) : createRoot(root);
    const activeRoot = mounted;
    paint = () => activeRoot.render(tree());
    if (!hydrate) paint();
  }
  try {
    await replace(saved === null ? undefined : { token: saved }, initial);
  } catch (error) {
    if (!(error instanceof KernelError) || error.code !== 'UNAUTHENTICATED' || saved === null)
      throw error;
    sessionStorage.removeItem(tokenKey);
    await replace(undefined, { reads: [] });
  }
  const close = () => {
    mounted?.unmount();
    release();
  };
  window.addEventListener('pagehide', close, { once: true });
  return close;
}
