// Navigation primitives — context, guards, history helpers

import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';

// ── Navigation context — shell provides, views consume ──
//
// Dual-shape API:
//   const navigate = useNavigate()                  → callable: navigate('/path')
//   const { navigate, makeHref } = useNavigate()    → destructurable
// makeHref(path) returns the same URL navigate() pushes to history (for <a href>,
// so right-click "open in new tab" works).
//
// NavigateFn returns boolean: true on success or no-op (same URL),
// false when navigation was blocked by checkBeforeNavigate().

export type NavigateFn = (path: string) => boolean;
export type MakeHrefFn = (path: string) => string;
export type NavigateApi = NavigateFn & { navigate: NavigateFn; makeHref: MakeHrefFn };

const NavigateCtxImpl = createContext<NavigateApi | null>(null);
export const NavigateProvider = NavigateCtxImpl.Provider;

export function useNavigate(): NavigateApi {
  const api = useContext(NavigateCtxImpl);
  if (!api) throw new Error('useNavigate: no NavigateProvider');
  return api;
}

// Build a NavigateApi from raw navigate + makeHref. The returned function is
// itself callable AND carries .navigate / .makeHref properties for destructuring.
export function makeNavigateApi(navigate: NavigateFn, makeHref: MakeHrefFn): NavigateApi {
  const api = ((path: string) => navigate(path)) as NavigateApi;
  api.navigate = navigate;
  api.makeHref = makeHref;
  return api;
}

// ── beforeNavigate guard — one view at a time can block SPA navigation ──
// Uses window to share state across Vite module instances

declare global {
  interface Window { __beforeNavigateMsg?: string | null; }
}

export function checkBeforeNavigate(): boolean {
  if (!window.__beforeNavigateMsg) return true;
  return confirm(window.__beforeNavigateMsg);
}

export function useBeforeNavigate(message: string) {
  useEffect(() => {
    const prev = window.__beforeNavigateMsg;
    if (prev && prev !== message) {
      console.warn('[useBeforeNavigate] overwriting existing guard:', prev, '→', message);
    }
    window.__beforeNavigateMsg = message;
    return () => {
      if (window.__beforeNavigateMsg === message) window.__beforeNavigateMsg = null;
    };
  }, [message]);
}

// ── History helper — centralised pushState so callers don't touch window.history directly ──

/** @deprecated Use navigateTo (guarded) or replaceTo (silent state sync) instead. */
export function pushHistory(url: string) {
  history.pushState(null, '', url);
}

// Canonicalize a same-origin URL to pathname+search+hash, preserving query order
// and duplicate params (so the equality check is encoding-insensitive only).
// Throws on cross-origin URLs — those are programmer errors at the navigation primitive.
function normalizeUrl(url: string): string {
  const u = new URL(url, location.origin);
  if (u.origin !== location.origin) {
    throw new Error(`navigateTo: cross-origin URL: ${url}`);
  }
  const search = u.searchParams.toString();
  return u.pathname + (search ? `?${search}` : '') + u.hash;
}

/**
 * Central URL mutator. Owns the unsaved-changes guard.
 * Returns true on success or no-op (target equals current URL).
 * Returns false when the guard blocked the navigation.
 */
export function navigateTo(url: string): boolean {
  const target = normalizeUrl(url);
  const current = normalizeUrl(location.pathname + location.search + location.hash);
  if (target === current) return true;
  if (!checkBeforeNavigate()) return false;
  history.pushState(null, '', target);
  window.dispatchEvent(new PopStateEvent('popstate'));
  return true;
}

/**
 * Replace the current URL without going through the navigation guard or pushing history.
 *
 * Use ONLY for non-user-initiated state synchronization (e.g., normalizing a URL on first load,
 * fixing up canonical form). NEVER use for root/selection changes or any link/click — those go
 * through navigateTo, which respects the unsaved-changes guard and creates a back-button entry.
 */
export function replaceTo(url: string): boolean {
  const target = normalizeUrl(url);
  const current = normalizeUrl(location.pathname + location.search + location.hash);
  if (target === current) return true;
  history.replaceState(null, '', target);
  window.dispatchEvent(new PopStateEvent('popstate'));
  return true;
}

// ── Editor URL builders — keep ?root= preserved across navigations ──

export function makeEditorHref(selected: string | null, root: string): string {
  const base = `/t${!selected || selected === '/' ? '' : selected}`;
  return root && root !== '/' ? `${base}?root=${encodeURIComponent(root)}` : base;
}

/** Push a new editor URL with `root` swapped out, preserving the selected path. */
export function setEditorRoot(root: string, selected: string | null): boolean {
  return navigateTo(makeEditorHref(selected, root));
}

// ── useLocation — subscribe a component to window.location via popstate ──

function subscribeLocation(callback: () => void) {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('popstate', callback);
  return () => window.removeEventListener('popstate', callback);
}

const getLocationHref = () => location.href;
// Server-side has no `location` — useSyncExternalStore needs a server snapshot
// or it throws. The actual pathname comes from ServerLocationContext below.
const getServerLocationHref = () => '';

/** Set by entry-server so SSR reads the request URL where useLocation expects window.location. */
export const ServerLocationContext = createContext<{ pathname: string; search: string; href: string } | null>(null);

export function useLocation(): Location {
  useSyncExternalStore(subscribeLocation, getLocationHref, getServerLocationHref);
  if (typeof window !== 'undefined') return window.location;
  const stub = useContext(ServerLocationContext);
  return (stub ?? { pathname: '/', search: '', href: '' }) as Location;
}
