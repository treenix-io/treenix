// AuthContext — lifts useAuth() out of Router so multiple consumers
// (Router branch logic, editor-shell view, future view-shell view) share
// one auth state machine instead of each instantiating their own.

import { createContext, createElement, type ReactNode, useContext } from 'react';
import type { AuthState } from './use-auth';
export interface AuthPort {
  login(userId: string, password: string): Promise<{ userId: string; pending?: boolean }>;
  register?: (userId: string, password: string) => Promise<{ userId: string; pending?: boolean }>;
  devLogin?: () => Promise<{ userId: string }>;
}
const Port = createContext<AuthPort | null>(null);

const Ctx = createContext<AuthState | null>(null);

/** Mounts a single useAuth() and exposes it to descendants via context. */
export function AuthProvider({ children, value, port }: { children: ReactNode; value: AuthState; port: AuthPort }) {
  return createElement(Port.Provider, { value: port }, createElement(Ctx.Provider, { value }, children));
}
export function useAuthPort(): AuthPort {
  const port = useContext(Port);
  if (port === null) throw new Error('Login requires an auth port');
  return port;
}

/** Read the shared auth state. Throws if no <AuthProvider> ancestor. */
export function useAuthContext(): AuthState {
  const auth = useContext(Ctx);
  if (!auth) throw new Error('useAuthContext requires <AuthProvider>');
  return auth;
}
