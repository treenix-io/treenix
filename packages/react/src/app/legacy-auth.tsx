import type { ReactNode } from 'react';
import { AuthProvider as Provider, type AuthPort } from './auth-context';
import { useAuth } from './use-auth';
import { setToken, trpc } from '#tree/trpc';

const port: AuthPort = {
  async login(userId, password) { const result = await trpc.login.mutate({ userId, password }); setToken(result.token); return result; },
  async register(userId, password) { const result = await trpc.register.mutate({ userId, password }); if (!result.pending) { if (result.token === null) throw new Error('Registration did not issue a token'); setToken(result.token); } return result; },
  async devLogin() { const result = await trpc.devLogin.mutate(); setToken(result.token); return result; },
};
export function AuthProvider({ children }: { children: ReactNode }) {
  return <Provider value={useAuth()} port={port}>{children}</Provider>;
}
