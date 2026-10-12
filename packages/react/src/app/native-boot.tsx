import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { KernelError } from '@treenx/core/errors';
import { isReadResult, isSelector } from '@treenx/core/protocol/twp';
import { NativeRouter } from '#app/NativeRouter';
import { LoginModal } from '#app/Login';
import { createLaneSession, type LaneSessionState } from '#tree/lane-session';
import type { NativeHydrationState } from '#tree/read-snapshot';
import { TreeSourceProvider } from '#tree/tree-source-context';
import { AuthProvider, type AuthPort, type AuthState } from '#app/auth-context';
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

/** Mount the original UI on the native owner of authentication, durable claims and reconnect. */
export async function bootNative(root: HTMLElement, initial: NativeHydrationState) {
  const tokenKey = 'treenix.native.token';
  const saved = sessionStorage.getItem(tokenKey);
  const session = createLaneSession(window.location.origin);
  let mounted: ReturnType<typeof createRoot> | undefined;
  let principal: string | null = null;
  let showLoginModal = false;
  let queryClient = new QueryClient();
  let queryOwner: Extract<LaneSessionState, { status: 'ready' }>['source'] | undefined;

  /** Display unexpected lifecycle failures without treating them as an anonymous admission. */
  function failed(error: unknown): void {
    console.error('[treenix] native session failed', error);
    root.textContent = error instanceof Error ? error.message : String(error);
  }

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
      void session.anonymous().catch(failed);
    },
  };
  const port: AuthPort = {
    async login(userId, password) {
      await session.login(userId.startsWith('/') ? userId : `/${userId}`, password);
      const state = session.getSnapshot();
      if (state.status !== 'ready')
        throw state.status === 'login' && state.error !== undefined
          ? state.error
          : new KernelError('UNAVAILABLE', 'Login did not admit a native lane');
      if (state.welcome.principal.startsWith('anon:'))
        throw new KernelError('UNAUTHENTICATED', 'Login opened an anonymous lane');
      return { userId: state.welcome.principal };
    },
  };

  /** Paint only an admitted source; a refused credential reopens anonymous ownership once. */
  function paint(): void {
    const state = session.getSnapshot();
    if (state.status === 'login' && state.error?.code === 'UNAUTHENTICATED' && principal !== null) {
      principal = null;
      sessionStorage.removeItem(tokenKey);
      showLoginModal = true;
      void session.anonymous().catch(failed);
      return;
    }
    principal =
      state.status === 'ready' && !state.welcome.principal.startsWith('anon:')
        ? state.welcome.principal
        : null;
    if (state.status === 'ready') {
      if (principal !== null && state.credential !== undefined)
        sessionStorage.setItem(tokenKey, state.credential.token);
      if (queryOwner !== state.source) {
        queryClient.clear();
        queryClient = new QueryClient();
        queryOwner = state.source;
      }
    } else {
      queryClient.clear();
      queryOwner = undefined;
      if (mounted === undefined) return;
    }
    const content =
      state.status === 'ready' ? (
        <TreeSourceProvider source={state.source}>
          <NativeRouter />
        </TreeSourceProvider>
      ) : state.status === 'connecting' ? (
        <p role="status" className="p-4">
          Connecting…
        </p>
      ) : (
        <LoginModal
          onLogin={(uid) => {
            auth.setAuthed(uid);
            auth.closeLoginModal();
          }}
          error={state.error?.message}
        />
      );
    const tree = (
      <AuthProvider value={{ ...auth }} port={port}>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider delayDuration={300}>
            {content}
            <Toaster />
          </TooltipProvider>
        </QueryClientProvider>
      </AuthProvider>
    );
    const hydrate = mounted === undefined && root.firstElementChild !== null;
    if (mounted === undefined) mounted = hydrate ? hydrateRoot(root, tree) : createRoot(root);
    if (!hydrate) mounted.render(tree);
  }

  const unsubscribe = session.subscribe(paint);
  function close(): void {
    unsubscribe();
    mounted?.unmount();
    queryClient.clear();
    session.close();
    window.removeEventListener('pagehide', close);
  }
  try {
    if (saved === null) await session.anonymous(initial);
    else {
      await session.restore({ token: saved }, initial);
      const state = session.getSnapshot();
      if (state.status === 'login' && state.error?.code === 'UNAUTHENTICATED') {
        sessionStorage.removeItem(tokenKey);
        await session.anonymous();
      }
    }
    const state = session.getSnapshot();
    if (state.status !== 'ready')
      throw state.status === 'login' && state.error !== undefined
        ? state.error
        : new KernelError('UNAVAILABLE', 'Native session did not open');
  } catch (error) {
    close();
    throw error;
  }
  window.addEventListener('pagehide', close, { once: true });
  return close;
}
