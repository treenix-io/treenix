import { declareClientModule, declareView } from '@treenx/react/context/client-registry';
import { getComponent } from '@treenx/core';
import { type View, useActions } from '@treenx/react';
import { useChildren } from '@treenx/react';
import { useState } from 'react';
import { ApiToken, ApiTokenManager } from './types';

const ApiTokensView: View<ApiTokenManager> = ({ value, ctx }) => {
  const path = ctx!.node.$path;
  const { data: children } = useChildren(path);
  // Read api users so we can show their groups next to each token preview.
  const { data: users } = useChildren('/auth/users');
  const actions = useActions(value);
  const [name, setName] = useState('');
  const [groupsInput, setGroupsInput] = useState('');
  const [scopeInput, setScopeInput] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  // Raw token is returned by `create` exactly once — server stores only the hash.
  // Capture it here so the user can copy it before it's gone forever.
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);

  const parseGroups = (input: string) =>
    input
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  const handleCreate = async () => {
    if (!name.trim() || !scopeInput.trim()) return;
    const result = await actions.create({
      name: name.trim(),
      groups: parseGroups(groupsInput),
      scope: parseGroups(scopeInput),
    });
    setFresh({ name: name.trim(), token: result.token });
    setName('');
    setGroupsInput('');
    setScopeInput('');
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
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
        />
        <input
          className="w-64 rounded bg-card px-3 py-1.5 text-sm text-foreground border border-border focus:border-border outline-none"
          placeholder="groups (comma-separated, e.g. admins)"
          value={groupsInput}
          onChange={(e) => setGroupsInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
        />
        <button
          className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
          onClick={handleCreate}
          disabled={!name.trim() || !scopeInput.trim()}
        >
          Create
        </button>
      </div>

      <input
        className="w-full rounded bg-card px-3 py-1.5 text-sm text-foreground border border-border focus:border-border outline-none"
        aria-label="Allowed paths"
        placeholder="allowed paths (comma-separated, e.g. /board, /docs)"
        value={scopeInput}
        onChange={(e) => setScopeInput(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
      />

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
          {children.map((child) => {
            const token = getComponent(child, ApiToken)!;
            const tokenId = child.$path.slice(path.length + 1);
            const userNode = users.find((u) => u.$path === token.accountPath);
            const userGroups =
              userNode === undefined
                ? undefined
                : getComponent<{ list: string[] }>(userNode, 't.groups')!.list;
            return (
              <div
                key={child.$path}
                className="flex items-center justify-between rounded bg-card/50 px-3 py-2 border border-border/50"
              >
                <div className="space-y-1 min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <span>{token.name}</span>
                    {token.preview && (
                      <code className="font-mono text-xs text-muted-foreground">
                        {token.preview}
                      </code>
                    )}
                    {userGroups?.map((g) => (
                      <span
                        key={g}
                        className="rounded bg-muted/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-foreground"
                      >
                        {g}
                      </span>
                    ))}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {token.principal} · {new Date(token.createdAt).toLocaleDateString()}
                  </div>
                </div>
                <button
                  className="ml-2 shrink-0 rounded bg-red-600/20 px-2 py-1 text-xs text-red-400 hover:bg-red-600/40"
                  onClick={() => actions.revoke({ id: tokenId })}
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

export const clientModules = [
  declareClientModule('@treenx/mods/mcp/view', [
    declareView('t.api.tokens', 'react', ApiTokensView),
  ]),
];
