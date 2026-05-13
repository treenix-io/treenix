// Auth state hook — bootstraps session from token, handles dev login,
// surfaces a re-login modal when the server emits AUTH_EXPIRED_EVENT.

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AUTH_EXPIRED_EVENT, clearToken, getToken, setToken, trpc } from '#tree/trpc';

export type AuthState = {
  authed: string | null;
  authChecked: boolean;
  showLoginModal: boolean;
  setAuthed: (uid: string | null) => void;
  closeLoginModal: () => void;
  logout: () => void;
};

// SSR has no localStorage / no token — start as "anonymous, checked" so
// Router renders content during SSR.
const IS_SSR = typeof window === 'undefined';
// Hydrated SSR pages must produce the same first client render before effects
// run. Token/dev-login validation can still update auth state after hydration.
const HAS_SSR_INITIAL_STATE =
  typeof document !== 'undefined' && !!document.getElementById('treenix-initial');

export function useAuth(): AuthState {
  const [authed, setAuthed] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(IS_SSR || HAS_SSR_INITIAL_STATE);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const initAuth = useCallback(async () => {
    const token = getToken();
    if (!token) {
      // No token, no dev login → anonymous. Server assigns 'public' claims on every request.
      setAuthed(null);
      setAuthChecked(true);
      return;
    }
    try {
      const res = await trpc.me.query();
      setAuthed(res?.userId ?? null);
      if (!res) clearToken();
      setAuthChecked(true);
    } catch (e: any) {
      const isAuthError = e?.data?.code === 'UNAUTHORIZED' || e?.data?.httpStatus === 401;
      if (isAuthError) {
        clearToken();
        setAuthChecked(true);
      } else {
        toast.error('Server unavailable, retrying…');
        retryTimer.current = setTimeout(initAuth, 3000);
      }
    }
  }, []);

  useEffect(() => {
    initAuth();
    return () => clearTimeout(retryTimer.current);
  }, [initAuth]);

  // Session expired mid-use → drop token, prompt login.
  useEffect(() => {
    const handler = () => {
      if (showLoginModal) return;
      clearToken();
      setAuthed(null);
      setShowLoginModal(true);
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, handler);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, handler);
  }, [showLoginModal]);

  const logout = useCallback(() => {
    clearToken();
    setAuthed(null);
    setShowLoginModal(true);
  }, []);

  const closeLoginModal = useCallback(() => setShowLoginModal(false), []);

  return { authed, authChecked, showLoginModal, setAuthed, closeLoginModal, logout };
}
