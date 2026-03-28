import { Button } from '#components/ui/button';
import { Dialog, DialogContent } from '#components/ui/dialog';
import { Input } from '#components/ui/input';
import { Label } from '#components/ui/label';
import { useState } from 'react';
import { setToken, trpc } from './trpc';

function LoginForm({ onLogin }: { onLogin: (userId: string) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [userId, setUserId] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!userId.trim() || !password) return;
    setLoading(true);
    setErr(null);
    try {
      const fn = mode === 'register' ? trpc.register : trpc.login;
      const res = await fn.mutate({ userId: userId.trim(), password });
      if (!res.token) throw new Error('No token received');
      setToken(res.token);
      onLogin(res.userId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="flex flex-col gap-4 w-80 p-8 rounded-lg border border-border bg-card" onSubmit={handleSubmit}>
      <div className="flex items-center justify-center gap-2 mb-2">
        <img src="/treenity.svg" alt="" width="32" height="32" />
        <span className="text-lg font-semibold">Treenity</span>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="userId">User ID</Label>
        <Input
          id="userId"
          autoFocus
          placeholder="Enter your user ID"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          placeholder="Enter password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>

      {err && <p className="text-sm text-destructive">{err}</p>}

      <Button type="submit" disabled={loading || !userId.trim() || !password}>
        {loading ? '...' : mode === 'register' ? 'Create account' : 'Sign in'}
      </Button>

      <Button
        type="button"
        variant="ghost"
        onClick={() => {
          setMode((m) => (m === 'login' ? 'register' : 'login'));
          setErr(null);
        }}
      >
        {mode === 'login' ? 'No account? Register' : 'Have an account? Sign in'}
      </Button>
    </form>
  );
}

export function LoginScreen({ onLogin }: { onLogin: (userId: string) => void }) {
  return (
    <div className="flex items-center justify-center h-screen bg-background">
      <LoginForm onLogin={onLogin} />
    </div>
  );
}

export function LoginModal({ onLogin, onClose }: { onLogin: (userId: string) => void; onClose?: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open && onClose) onClose(); }}>
      <DialogContent className="p-0 border-none bg-transparent shadow-none max-w-fit" showCloseButton={!!onClose}>
        <LoginForm onLogin={onLogin} />
      </DialogContent>
    </Dialog>
  );
}
