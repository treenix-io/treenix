import { register } from '@treenity/core';
import { type View } from '@treenity/react/context';
import { execute, set, useChildren, useNavigate } from '@treenity/react/hooks';
import { cn } from '@treenity/react/lib/utils';
import { useCallback, useState } from 'react';

import type { MetatronConfig } from '../types';
import { LogRenderer } from './log';
import { formatTime, StatusDot } from './shared';

// ── Permission Manager ──

function PermissionManager({ configPath }: { configPath: string }) {
  const permissions = useChildren(`${configPath}/permissions`, { watch: true, watchNew: true });
  const [adding, setAdding] = useState(false);
  const [tool, setTool] = useState('');
  const [policy, setPolicy] = useState<'allow' | 'deny'>('deny');

  const rules = (permissions ?? []).filter(n => n.$type === 'metatron.permission');

  const handleAdd = useCallback(async () => {
    if (!tool.trim()) return;
    const trpc = (await import('@treenity/react/trpc')).trpc;
    const { createNode } = await import('@treenity/core');
    const id = `rule-${Date.now()}`;
    const path = `${configPath}/permissions/${id}`;
    await trpc.set.mutate({ node: createNode(path, 'metatron.permission', {
      tool: tool.trim(),
      policy,
      createdAt: Date.now(),
    }) as Record<string, unknown> });
    setTool('');
    setAdding(false);
  }, [tool, policy, configPath]);

  const handleRemove = useCallback(async (path: string) => {
    const trpc = (await import('@treenity/react/trpc')).trpc;
    await trpc.remove.mutate({ path });
  }, []);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-zinc-600 uppercase tracking-wider font-medium">Permissions</span>
        <button
          onClick={() => setAdding(!adding)}
          className="ml-auto text-[11px] text-zinc-600 hover:text-violet-400 transition-colors duration-200"
        >
          {adding ? 'cancel' : '+ rule'}
        </button>
      </div>

      {adding && (
        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <input
              value={tool}
              onChange={e => setTool(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleAdd(); }}
              placeholder="mcp__treenity__remove_node"
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-violet-600/50 placeholder:text-zinc-700"
            />
          </div>
          <select
            value={policy}
            onChange={e => setPolicy(e.target.value as 'allow' | 'deny')}
            className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-xs text-zinc-300"
          >
            <option value="allow">allow</option>
            <option value="deny">deny</option>
          </select>
          <button
            onClick={handleAdd}
            disabled={!tool.trim()}
            className="px-3 py-1.5 rounded-lg text-[11px] font-medium bg-violet-600 hover:bg-violet-500 text-white disabled:bg-zinc-800 disabled:text-zinc-600 transition-all shrink-0"
          >
            Add
          </button>
        </div>
      )}

      {rules.length > 0 ? (
        <div className="flex flex-col gap-1">
          {rules.map(r => (
            <div key={r.$path} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-950/60 border border-zinc-800/60">
              <span className={cn(
                'text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded',
                r.policy === 'deny' ? 'bg-red-500/15 text-red-400' : 'bg-emerald-500/15 text-emerald-400'
              )}>
                {String(r.policy)}
              </span>
              <span className="text-xs text-zinc-300 font-mono truncate flex-1">{String(r.tool)}</span>
              {r.pathPattern ? (
                <span className="text-[10px] text-zinc-600 font-mono truncate">{String(r.pathPattern)}</span>
              ) : null}
              <button
                onClick={() => handleRemove(r.$path)}
                className="text-zinc-700 hover:text-red-400 transition-colors p-0.5 shrink-0"
                title="Remove rule"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-[11px] text-zinc-700 italic">No rules — all MCP tools allowed</p>
      )}
    </div>
  );
}

// ── Done section ──

function DoneSection({ tasks }: { tasks: Array<Record<string, unknown>> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-[10px] text-zinc-600 uppercase tracking-wider font-medium hover:text-zinc-400 transition-colors text-left"
      >
        <svg
          width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          className={cn('transition-transform duration-200', open && 'rotate-90')}
        >
          <path d="M9 18l6-6-6-6" />
        </svg>
        Completed ({tasks.length})
      </button>
      {open && (
        <div className="flex flex-col gap-1.5">
          {tasks.map(task => <TaskRowInline key={String(task.$path)} task={task} />)}
        </div>
      )}
    </div>
  );
}

// Inline simplified TaskRow for DoneSection (avoids circular import)
function TaskRowInline({ task }: { task: Record<string, unknown> }) {
  const status = (task.status as string) || 'pending';
  const prompt = (task.prompt as string) || '';
  const result = (task.result as string) || '';
  const taskLog = (task.log as string) || '';
  const hasLog = !!taskLog;
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<'result' | 'log'>(hasLog ? 'log' : 'result');
  const time = task.createdAt ? formatTime(task.createdAt as number) : '';

  return (
    <div className={cn(
      'rounded-xl border transition-all duration-200',
      expanded ? 'bg-zinc-900/80 border-zinc-800' : 'bg-zinc-900/40 border-zinc-800/60 hover:border-zinc-700'
    )}>
      <div
        className="flex items-center gap-2.5 px-3.5 py-2.5 cursor-pointer select-none"
        onClick={() => setExpanded(!expanded)}
      >
        <StatusDot status={status} />
        <span className="text-sm text-zinc-300 truncate flex-1">{prompt}</span>
        <span className="text-[10px] text-zinc-600 shrink-0 font-mono">{time}</span>
        <svg
          width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          className={cn('text-zinc-600 transition-transform duration-200 shrink-0', expanded && 'rotate-90')}
        >
          <path d="M9 18l6-6-6-6" />
        </svg>
      </div>

      {expanded && (
        <div className="border-t border-zinc-800/60">
          <div className="flex gap-1 px-2 py-1">
            {(['log', 'result'] as const).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  'px-2 py-0.5 rounded-md text-[11px] font-medium transition-all duration-150',
                  tab === t ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-600 hover:text-zinc-400'
                )}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            <LogRenderer text={tab === 'result' ? (result || 'No result yet') : (taskLog || result || 'No log yet')} />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Config View ──

const ConfigView: View<MetatronConfig> = ({ value, ctx }) => {
  const navigate = useNavigate();
  const path = ctx!.path;
  const children = useChildren(`${path}/tasks`, { watch: true, watchNew: true });
  const wsChildren = useChildren(`${path}/workspaces`, { watch: true, watchNew: true });
  const templateChildren = useChildren(`${path}/templates`, { watch: true });
  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const [showConfig, setShowConfig] = useState(false);

  const allTasks = (children ?? [])
    .filter(c => c.$type === 'metatron.task')
    .sort((a, b) => ((b.createdAt as number) || 0) - ((a.createdAt as number) || 0));

  const workspaces = (wsChildren ?? []).filter(c => c.$type === 'metatron.workspace');
  const templates = (templateChildren ?? []).filter(c => c.$type === 'metatron.template' && c.prompt);
  const active = allTasks.filter(t => t.status !== 'done');
  const done = allTasks.filter(t => t.status === 'done');

  const handleRun = useCallback(async () => {
    const text = prompt.trim();
    if (!text) return;
    setSending(true);
    try {
      await execute(path, 'task', { prompt: text });
      setPrompt('');
    } finally {
      setSending(false);
    }
  }, [prompt, path]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleRun();
  }, [handleRun]);

  const node = ctx!.node;

  const onSystemPromptChange = useCallback((val: string) => {
    set({ ...node, systemPrompt: val });
  }, [node]);

  const clearSession = useCallback(() => {
    set({ ...node, sessionId: '' });
  }, [node]);

  const handleNewWorkspace = useCallback(async () => {
    const name = window.prompt('Workspace name:');
    if (!name?.trim()) return;
    const trpc = (await import('@treenity/react/trpc')).trpc;
    const { createNode } = await import('@treenity/core');
    const id = `ws-${Date.now()}`;
    const wsPath = `${path}/workspaces/${id}`;
    await trpc.set.mutate({ node: createNode(wsPath, 'metatron.workspace', {
      name: name.trim(),
      columns: [],
    }) });
    navigate(wsPath);
  }, [path]);

  const systemPrompt = String(value.systemPrompt ?? '');
  const hasSession = !!(value.sessionId as string);

  return (
    <div className="flex flex-col gap-6 p-5 max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-600 to-indigo-700 flex items-center justify-center text-white text-sm font-bold shadow-lg shadow-violet-600/20">
          M
        </div>
        <div className="flex-1">
          <h1 className="text-base font-semibold text-zinc-100 tracking-tight">Metatron</h1>
          <p className="text-[11px] text-zinc-500">AI task orchestrator</p>
        </div>
        <button
          onClick={() => setShowConfig(!showConfig)}
          className={cn(
            'w-7 h-7 rounded-md flex items-center justify-center text-zinc-500 transition-all duration-200',
            showConfig ? 'bg-zinc-800 text-zinc-300' : 'hover:bg-zinc-800/60 hover:text-zinc-400'
          )}
          title="Settings"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
        </button>
      </div>

      {/* Config panel (collapsible) */}
      {showConfig && (
        <div className="flex flex-col gap-3 p-4 rounded-xl bg-zinc-900/80 border border-zinc-800">
          <div className="flex items-center gap-2">
            {hasSession ? (
              <span className="flex items-center gap-1.5 text-[11px] text-zinc-500 font-mono">
                session {(value.sessionId as string).slice(0, 8)}
                <button onClick={clearSession} className="text-zinc-600 hover:text-red-400 transition-colors" title="Clear session">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
              </span>
            ) : (
              <span className="text-[11px] text-zinc-600">no session</span>
            )}
            {value.lastRun ? (
              <span className="text-[11px] text-zinc-600 ml-auto">last run {formatTime(value.lastRun as number)}</span>
            ) : null}
          </div>
          <label className="text-[10px] text-zinc-600 uppercase tracking-wider font-medium">System prompt</label>
          <textarea
            value={systemPrompt}
            onChange={e => onSystemPromptChange(e.target.value)}
            rows={10}
            placeholder="Metatron operating instructions..."
            className="bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2.5 text-xs font-mono text-zinc-300 resize-y focus:outline-none focus:border-violet-600/50 focus:ring-1 focus:ring-violet-600/20 transition-all duration-200 placeholder:text-zinc-700"
          />
          <PermissionManager configPath={path} />
        </div>
      )}

      {/* Workspaces */}
      {(workspaces.length > 0 || true) && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-zinc-600 uppercase tracking-wider font-medium">Workspaces</span>
            <button
              onClick={handleNewWorkspace}
              className="ml-auto text-[11px] text-zinc-600 hover:text-violet-400 transition-colors duration-200"
            >
              + new
            </button>
          </div>
          {workspaces.length > 0 ? (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {workspaces.map(ws => (
                <button
                  key={ws.$path}
                  onClick={() => navigate(ws.$path as string)}
                  className="flex flex-col gap-1 px-4 py-3 rounded-xl bg-zinc-900/60 border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-800/60 transition-all duration-200 min-w-[140px] group"
                >
                  <span className="text-sm text-zinc-300 font-medium truncate group-hover:text-zinc-100 transition-colors">
                    {String(ws.name) || (ws.$path as string).split('/').at(-1)}
                  </span>
                  <span className="text-[10px] text-zinc-600 font-mono">
                    {Array.isArray(ws.columns) ? ws.columns.length : 0} columns
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-zinc-700 italic">No workspaces yet</p>
          )}
        </div>
      )}

      {/* Templates (horizontal pills) */}
      {templates.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto pb-0.5">
          {templates.map(t => (
            <button
              key={t.$path}
              onClick={() => setPrompt(String(t.prompt))}
              className="px-3 py-1.5 rounded-lg text-[11px] font-medium bg-zinc-900/60 border border-zinc-800 text-zinc-400 hover:border-violet-600/40 hover:text-violet-300 transition-all duration-200 whitespace-nowrap shrink-0"
            >
              {String(t.name) || String(t.prompt).slice(0, 30)}
            </button>
          ))}
        </div>
      )}

      {/* Task input */}
      <div className="flex flex-col gap-2">
        <div className="relative">
          <textarea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={2}
            placeholder="What should Metatron do?"
            className="w-full bg-zinc-900/60 border border-zinc-800 rounded-xl px-4 py-3 pr-20 text-sm text-zinc-200 resize-y focus:outline-none focus:border-violet-600/50 focus:ring-1 focus:ring-violet-600/20 transition-all duration-200 placeholder:text-zinc-600"
          />
          <button
            onClick={handleRun}
            disabled={sending || !prompt.trim()}
            className={cn(
              'absolute right-2 bottom-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all duration-200',
              prompt.trim()
                ? 'bg-violet-600 hover:bg-violet-500 text-white shadow-sm shadow-violet-600/20'
                : 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
            )}
          >
            {sending ? '...' : 'Run'}
          </button>
        </div>
        <span className="text-[10px] text-zinc-700 pl-1">Cmd+Enter to send</span>
      </div>

      {/* Active tasks */}
      {active.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-[10px] text-zinc-600 uppercase tracking-wider font-medium">
            Active ({active.length})
          </span>
          <div className="flex flex-col gap-1.5">
            {active.map(task => <TaskRowInline key={String(task.$path)} task={task} />)}
          </div>
        </div>
      )}

      {/* Done */}
      {done.length > 0 && <DoneSection tasks={done} />}
    </div>
  );
}

register('metatron.config', 'react', ConfigView);
register('metatron.config', 'react:layout', ConfigView);
