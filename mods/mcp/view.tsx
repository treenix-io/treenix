import { register } from '@treenity/core';
import { type View, useActions } from '@treenity/react';
import { useChildren } from '@treenity/react';
import { useState } from 'react';
import { ApiTokenManager } from './types';

const ApiTokensView: View<ApiTokenManager> = ({ value, ctx }) => {
  const path = ctx!.node.$path;
  const children = useChildren(path) ?? [];
  const actions = useActions(value);
  const [name, setName] = useState('');
  const [copied, setCopied] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!name.trim()) return;
    await actions.create({ name: name.trim() });
    setName('');
  };

  const copyToken = (token: string) => {
    navigator.clipboard.writeText(token);
    setCopied(token);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div className="space-y-4 p-4">
      <h2 className="text-lg font-semibold text-zinc-100">API Tokens</h2>

      <div className="flex gap-2">
        <input
          className="flex-1 rounded bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 border border-zinc-700 focus:border-zinc-500 outline-none"
          placeholder="token name (e.g. claude-code)"
          value={name}
          onChange={e => setName(e.target.value)}
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

      {children.length === 0 ? (
        <p className="text-sm text-zinc-500">No tokens yet</p>
      ) : (
        <div className="space-y-2">
          {children.map(child => {
            const tokenName = typeof child.name === 'string' ? child.name : child.$path.split('/').pop() ?? '';
            const userId = typeof child.userId === 'string' ? child.userId : '';
            const createdAt = typeof child.createdAt === 'number' || typeof child.createdAt === 'string' ? child.createdAt : null;
            const token = typeof child.token === 'string' ? child.token : null;
            return (
              <div key={child.$path} className="flex items-center justify-between rounded bg-zinc-800/50 px-3 py-2 border border-zinc-700/50">
                <div className="space-y-1 min-w-0 flex-1">
                  <div className="text-sm font-medium text-zinc-200">{tokenName}</div>
                  <div className="text-xs text-zinc-500">
                    {userId}{createdAt ? ` · ${new Date(createdAt).toLocaleDateString()}` : ''}
                  </div>
                  {token && (
                    <code
                      className="block text-xs text-zinc-400 cursor-pointer hover:text-zinc-200 truncate"
                      onClick={() => copyToken(token)}
                      title="Click to copy"
                    >
                      {copied === token ? 'Copied!' : token}
                    </code>
                  )}
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
