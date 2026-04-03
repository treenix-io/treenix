// Navigation primitives — context, guards, history helpers

import { createContext, useContext, useEffect } from 'react';

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

export function checkBeforeNavigate(): boolean {
  const msg = (window as Record<string, unknown>).__beforeNavigateMsg as string | null;
  if (!msg) return true;
  return confirm(msg);
}

export function useBeforeNavigate(message: string) {
  useEffect(() => {
    const w = window as Record<string, unknown>;
    const prev = w.__beforeNavigateMsg as string | null | undefined;
    if (prev && prev !== message) {
      console.warn('[useBeforeNavigate] overwriting existing guard:', prev, '→', message);
    }
    w.__beforeNavigateMsg = message;
    return () => {
      if (w.__beforeNavigateMsg === message) w.__beforeNavigateMsg = null;
    };
  }, [message]);
}

// ── History helper — centralised pushState so callers don't touch window.history directly ──

export function pushHistory(url: string) {
  history.pushState(null, '', url);
}
