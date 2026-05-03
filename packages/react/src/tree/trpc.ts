/// <reference types="vite/client" />
import { createTrpcTransport } from '@treenx/core/client';

declare global {
  interface ImportMetaEnv {
    readonly VITE_API_URL?: string;
  }
}

const TOKEN_KEY = 'treenix_token';

// URL: Vite (browser) → Expo (RN) → relative ('') as last resort.
// import.meta.env is defined under Vite; process.env under Metro/Node.
const url =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_URL) ||
  (typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_TREENIX_URL) ||
  '';

// Storage: localStorage in browser, in-memory fallback elsewhere (RN, Node).
// RN apps that need persistence wrap setToken/getToken with AsyncStorage themselves.
let memoryToken: string | null = null;
const hasLocalStorage = typeof localStorage !== 'undefined';

export function getToken(): string | null {
  return hasLocalStorage ? localStorage.getItem(TOKEN_KEY) : memoryToken;
}

export function setToken(token: string) {
  if (hasLocalStorage) localStorage.setItem(TOKEN_KEY, token);
  else memoryToken = token;
}

export function clearToken() {
  if (hasLocalStorage) localStorage.removeItem(TOKEN_KEY);
  else memoryToken = null;
}

export const AUTH_EXPIRED_EVENT = 'trpc:auth-expired';

const authFetch = async (url: string | URL | Request, opts?: RequestInit): Promise<Response> => {
  const res = await fetch(url, opts);
  // Only treat 401 as "session expired" when a token is actually present.
  // A 401 with no token is a failed login/register attempt — the form handles it.
  if (res.status === 401 && getToken() && typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
  }
  return res;
};

export const { trpc } = createTrpcTransport({ url, getToken, fetch: authFetch });
