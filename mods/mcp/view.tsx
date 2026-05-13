import { register } from '@treenx/core';
import { type View, useActions } from '@treenx/react';
import { useChildren } from '@treenx/react';
import { useState } from 'react';
import { ApiTokenManager } from './types';

const ApiTokensView: View<ApiTokenManager> = ({ value, ctx }) => {
  const path = ctx!.node.$path;
  const { data: children } = useChildren(path);
  // Read api users so we can show their groups next to each token preview.
  const { data: users } = useChildren('/auth/users');
  const actions = useActions(value);
  const [name, setName] = useState('');
  const [groupsInput, setGroupsInput] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  // Raw token is returned by `create` exactly once — server stores only the hash.
  // Capture it here so the user can copy it before it's gone forever.
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);

  const parseGroups = (input: string) =>
    input.split(',').map(s => s.trim()).filter(Boolean);

  const handleCreate = async () => {
    if (!name.trim()) return;
    const result = await actions.create({ name: name.trim(), groups: parseGroups(groupsInput) });
    const token = (result as { token?: unknown } | null)?.token;
    if (typeof token === 'string') setFresh({ name: name.trim(), token });
    setName('');
    setGroupsInput('');
  };

  const copyToken = (token: string) => {
    navigator.clipboard.writeText(token);
    setCopied(token);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div className="space-y-4 p-4">
      <h2 className="text-lg font-semibold text-foreground">API Tokens</h2>

      <div className="flex gap-2">
        <input
          className="flex-1 rounded bg-card px-3 py-1.5 text-sm text-foreground border border-border focus:border-border outline-none"
          placeholder="token name (e.g. claude-code)"
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleCreate()}
        />
        <input
          className="w-64 rounded bg-card px-3 py-1.5 text-sm text-foreground border border-border focus:border-border outline-none"
          placeholder="groups (comma-separated, e.g. admins)"
          value={groupsInput}
          onChange={e => setGroupsInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleCreate()}
        />
        <button
          className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
          onClick={handleCreate}
          disabled={!name.trim()}
        >
          Create
        </button>
      </div>

      {fresh && (
        <div className="space-y-2 rounded border border-amber-500/40 bg-amber-500/10 p-3">
          <div className="text-xs font-medium text-amber-300">
            Token for "{fresh.name}" — copy now, it will not be shown again.
          </div>
          <div className="flex items-center gap-2">
            <code
              className="flex-1 truncate text-xs text-amber-100 cursor-pointer hover:text-white"
              onClick={() => copyToken(fresh.token)}
              title="Click to copy"
            >
              {copied === fresh.token ? 'Copied!' : fresh.token}
            </code>
            <button
              className="rounded bg-amber-500/20 px-2 py-1 text-xs text-amber-200 hover:bg-amber-500/40"
              onClick={() => setFresh(null)}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {children.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tokens yet</p>
      ) : (
        <div className="space-y-2">
          {children.map(child => {
            const tokenName = typeof child.name === 'string' ? child.name : child.$path.split('/').pop() ?? '';
            const userId = typeof child.userId === 'string' ? child.userId : '';
            const createdAt = typeof child.createdAt === 'number' || typeof child.createdAt === 'string' ? child.createdAt : null;
            const preview = typeof child.preview === 'string' ? child.preview : null;
            const userNode = users.find(u => u.$path === `/auth/users/${userId}`);
            const groupsComp = userNode && (userNode as { groups?: { list?: unknown } }).groups;
            const userGroups = Array.isArray(groupsComp?.list)
              ? (groupsComp!.list as unknown[]).filter((g): g is string => typeof g === 'string')
              : [];
            return (
              <div key={child.$path} className="flex items-center justify-between rounded bg-card/50 px-3 py-2 border border-border/50">
                <div className="space-y-1 min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <span>{tokenName}</span>
                    {preview && (
                      <code className="font-mono text-xs text-muted-foreground">{preview}</code>
                    )}
                    {userGroups.map(g => (
                      <span key={g} className="rounded bg-muted/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-foreground">
                        {g}
                      </span>
                    ))}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {userId}{createdAt ? ` · ${new Date(createdAt).toLocaleDateString()}` : ''}
                  </div>
                </div>
                <button
                  className="ml-2 shrink-0 rounded bg-red-600/20 px-2 py-1 text-xs text-red-400 hover:bg-red-600/40"
                  onClick={() => actions.revoke({ name: tokenName })}
                >
                  Revoke
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

register('t.api.tokens', 'react', ApiTokensView);
