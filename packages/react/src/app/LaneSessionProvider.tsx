import { useEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import type { Credential } from '@treenx/core/kernel/types';
import { Button } from '#components/ui/button';
import { Input } from '#components/ui/input';
import { TreeSourceProvider } from '#tree/tree-source-context';
import type { createLaneSession } from '#tree/lane-session';

/** Show the actual native authentication state before exposing a principal-owned source to descendants. */
export function LaneSessionProvider({ session, credential, children }: {
  session: ReturnType<typeof createLaneSession>;
  credential?: Credential;
  children: ReactNode;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [account, setAccount] = useState('/admin'), [password, setPassword] = useState('');
  const [failure, setFailure] = useState<Error>();
  useEffect(() => {
    const opening = credential === undefined ? session.anonymous() : session.restore(credential);
    void opening.catch(error => { console.error(error); setFailure(error instanceof Error ? error : new Error(String(error))); });
  }, [session, credential?.token]);

  async function login(event: FormEvent): Promise<void> {
    event.preventDefault();
    setFailure(undefined);
    try { await session.login(account, password); setPassword(''); }
    catch (error) { console.error(error); setFailure(error instanceof Error ? error : new Error(String(error))); }
  }

  if (state.status === 'ready') return <TreeSourceProvider source={state.source}>{children}</TreeSourceProvider>;
  if (state.status === 'connecting' && failure === undefined) return <p role="status" className="p-4">Connecting…</p>;
  return <form onSubmit={login} className="mx-auto flex max-w-sm flex-col gap-3 p-4">
    <h1 className="text-lg font-semibold">Sign in</h1>
    <label>Account<Input value={account} onChange={event => setAccount(event.target.value)} autoComplete="username" /></label>
    <label>Password<Input value={password} onChange={event => setPassword(event.target.value)} type="password" autoComplete="current-password" /></label>
    {(failure ?? (state.status === 'login' ? state.error : undefined)) !== undefined && <p role="alert">{(failure ?? (state.status === 'login' ? state.error : undefined))?.message}</p>}
    <Button type="submit">Sign in</Button>
  </form>;
}
