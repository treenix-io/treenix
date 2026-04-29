import { createTrpcTransport } from '@treenx/core/client';

const TOKEN_KEY = 'treenix_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export const AUTH_EXPIRED_EVENT = 'trpc:auth-expired';

const authFetch = async (url: any, opts: any): Promise<Response> => {
  const res = await fetch(url, opts);
  if (res.status === 401) {
    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
  }
  return res;
};

export const { trpc } = createTrpcTransport({ url: '', getToken, fetch: authFetch });
