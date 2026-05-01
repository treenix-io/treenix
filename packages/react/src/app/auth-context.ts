// AuthContext — lifts useAuth() out of Router so multiple consumers
// (Router branch logic, editor-shell view, future view-shell view) share
// one auth state machine instead of each instantiating their own.

import { createContext, createElement, type ReactNode, useContext } from 'react';
import { type AuthState, useAuth } from './use-auth';

const Ctx = createContext<AuthState | null>(null);

/** Mounts a single useAuth() and exposes it to descendants via context. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  return createElement(Ctx.Provider, { value: auth }, children);
}

/** Read the shared auth state. Throws if no <AuthProvider> ancestor. */
export function useAuthContext(): AuthState {
  const auth = useContext(Ctx);
  if (!auth) throw new Error('useAuthContext requires <AuthProvider>');
  return auth;
}
