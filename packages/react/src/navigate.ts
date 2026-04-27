// Navigation primitives — context, guards, history helpers

import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';

// ── Navigation context — shell provides, views consume ──

export type NavigateFn = (path: string) => void;
const NavigateCtx = createContext<NavigateFn | null>(null);
export const NavigateProvider = NavigateCtx.Provider;

export function useNavigate(): NavigateFn {
  const nav = useContext(NavigateCtx);
  if (!nav) throw new Error('useNavigate: no NavigateProvider');
  return nav;
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

export function pushHistory(url: string) {
  history.pushState(null, '', url);
}

// ── useLocation — subscribe a component to window.location via popstate ──

function subscribeLocation(callback: () => void) {
  window.addEventListener('popstate', callback);
  return () => window.removeEventListener('popstate', callback);
}

const getLocationHref = () => location.href;

export function useLocation(): Location {
  useSyncExternalStore(subscribeLocation, getLocationHref);
  return location;
}
