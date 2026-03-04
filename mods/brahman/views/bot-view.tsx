// Bot view — read-only display of bot config + pages list

import type { NodeData } from '@treenity/core/core';
import { Render, RenderContext } from '@treenity/react/context';
import { useChildren } from '@treenity/react/hooks';
import { Bot } from 'lucide-react';
import type { BotConfig } from '../types';

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-muted-foreground w-32 shrink-0">{label}</span>
      <span className={`text-sm ${value ? '' : 'text-muted-foreground/50 italic'}`}>{value || '—'}</span>
    </div>
  );
}

export function BotView({ value }: { value: NodeData }) {
  const bot = value as NodeData & BotConfig;
  const pages = useChildren(`${value.$path}/pages`, { watch: true, watchNew: true });
  const isActive = !bot.maintenance;

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-2.5 rounded-lg bg-primary/10">
          <Bot className="h-6 w-6 text-primary" />
        </div>
        <div>
          <div className="text-lg font-semibold">{bot.name || bot.alias || 'Untitled Bot'}</div>
          <div className="flex items-center gap-2">
            {bot.alias && <span className="text-sm text-muted-foreground">{bot.alias}</span>}
            <span className={`text-xs px-1.5 py-0.5 rounded ${isActive ? 'bg-green-500/10 text-green-600' : 'bg-yellow-500/10 text-yellow-600'}`}>
              {isActive ? 'Active' : 'Maintenance'}
            </span>
          </div>
        </div>
      </div>

      {/* Config */}
      <div className="space-y-2">
        <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
          Configuration
        </div>
        <Field label="Token" value={bot.token ? '••••••' + bot.token.slice(-6) : ''} />
        <Field label="Alias" value={bot.alias ?? ''} />
        <Field label="Display name" value={bot.name ?? ''} />
        <Field label="Languages" value={bot.langs ?? ''} />
        <Field label="Proxy" value={bot.proxy ?? ''} />
        <Field label="Maintenance" value={bot.maintenance ?? ''} />
      </div>

      {/* Pages */}
      <div className="space-y-2">
        <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
          Pages ({pages.length})
        </div>

        <RenderContext name="react:list">
          <div className="children-grid">
            {pages.map(page => (
              <Render key={page.$path} value={page} />
            ))}
          </div>
        </RenderContext>

        {pages.length === 0 && (
          <div className="text-sm text-muted-foreground text-center py-6 border border-dashed border-border rounded-md">
            No pages yet.
          </div>
        )}
      </div>
    </div>
  );
}
