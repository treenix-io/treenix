import { register } from '@treenity/core';
import { Render, type View } from '@treenity/react/context';
import { execute, useChildren, usePath } from '@treenity/react/hooks';
import { cn } from '@treenity/react/lib/utils';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { MetatronWorkspace } from '../types';
import { LogRenderer } from './log';
import { formatTime, StatusDot } from './shared';

// ── Types ──

type SessionInfo = { id: string; date: string; messageCount: number; firstMessage: string };
type SearchResult = { sessionId: string; date: string; role: string; snippet: string; score: number };

// ── Command Picker (modal overlay for adding columns) ──

function CommandPicker({ configPath, exclude, onSelect, onNewTask, onClose }: {
  configPath: string;
  exclude: string[];
  onSelect: (ref: string) => void;
  onNewTask: (prompt: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [newTaskPrompt, setNewTaskPrompt] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  const allTasks = useChildren(`${configPath}/tasks`, { watch: true });
  const tasks = (allTasks ?? [])
    .filter(t => t.$type === 'metatron.task' && !exclude.includes(t.$path as string))
    .sort((a, b) => ((b.createdAt as number) || 0) - ((a.createdAt as number) || 0));

  // Load sessions on mount
  useEffect(() => {
    execute(configPath, 'listSessions', { lastN: 50 }).then(r => {
      if (Array.isArray(r)) setSessions(r);
    });
  }, [configPath]);

  // Auto-focus
  useEffect(() => { inputRef.current?.focus(); }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Debounced search
  useEffect(() => {
    if (!query.trim()) { setSearchResults([]); return; }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await execute(configPath, 'searchSessions', { query: query.trim(), maxResults: 20 });
        if (Array.isArray(r)) setSearchResults(r);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, configPath]);

  const isSearching = !!query.trim();

  const filteredTasks = isSearching
    ? tasks.filter(t => String(t.prompt ?? '').toLowerCase().includes(query.toLowerCase()))
    : tasks;

  const filteredSessions = isSearching
    ? sessions.filter(s => s.firstMessage.toLowerCase().includes(query.toLowerCase()))
    : sessions;

  const handleNewTask = () => {
    const text = newTaskPrompt.trim();
    if (!text) return;
    onNewTask(text);
    onClose();
  };

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === backdropRef.current) onClose(); }}
    >
      <div className="w-full max-w-lg bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl shadow-black/40 overflow-hidden flex flex-col max-h-[60vh]">
        {/* Search */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-zinc-500 shrink-0">
            <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search tasks and sessions..."
            className="flex-1 bg-transparent text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none"
          />
          {searching && (
            <span className="text-[10px] text-zinc-600 animate-pulse">searching...</span>
          )}
          <button onClick={onClose} className="text-zinc-600 hover:text-zinc-400 transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>

        <div className="overflow-y-auto flex-1">
          {/* New task */}
          {!isSearching && (
            <div className="flex flex-col gap-2 px-4 py-2.5 border-b border-zinc-800/60">
              <textarea
                value={newTaskPrompt}
                onChange={e => setNewTaskPrompt(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && newTaskPrompt.trim()) handleNewTask(); }}
                rows={2}
                placeholder="New task prompt..."
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-200 resize-none focus:outline-none focus:border-violet-600/50 placeholder:text-zinc-700"
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={handleNewTask}
                  disabled={!newTaskPrompt.trim()}
                  className="px-3 py-1.5 rounded-lg text-[11px] font-medium bg-violet-600 hover:bg-violet-500 text-white disabled:bg-zinc-800 disabled:text-zinc-600 transition-all shrink-0"
                >
                  Create & add
                </button>
                <span className="text-[10px] text-zinc-700">Cmd+Enter</span>
              </div>
            </div>
          )}

          {/* Search results (when searching) */}
          {isSearching && searchResults.length > 0 && (
            <div className="py-1">
              <div className="px-4 py-1.5">
                <span className="text-[10px] text-zinc-600 uppercase tracking-wider font-medium">
                  Session matches ({searchResults.length})
                </span>
              </div>
              {searchResults.map((r, i) => (
                <button
                  key={`sr-${i}`}
                  onClick={() => { onSelect(`session:${r.sessionId}`); onClose(); }}
                  className="flex flex-col gap-1 w-full px-4 py-2.5 text-left hover:bg-zinc-800/60 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-zinc-600 font-mono">{r.date}</span>
                    <span className={cn(
                      'text-[10px] font-medium',
                      r.role === 'user' ? 'text-sky-500' : 'text-emerald-500'
                    )}>
                      {r.role}
                    </span>
                    <span className="text-[10px] text-zinc-700 ml-auto font-mono">{r.score.toFixed(1)}</span>
                  </div>
                  <span className="text-xs text-zinc-400 line-clamp-2 leading-relaxed">{r.snippet}</span>
                </button>
              ))}
            </div>
          )}

          {/* Tasks */}
          {filteredTasks.length > 0 && (
            <div className="py-1">
              <div className="px-4 py-1.5">
                <span className="text-[10px] text-zinc-600 uppercase tracking-wider font-medium">Tasks</span>
              </div>
              {filteredTasks.map(t => (
                <button
                  key={t.$path}
                  onClick={() => { onSelect(t.$path as string); onClose(); }}
                  className="flex items-center gap-2.5 w-full px-4 py-2 text-left hover:bg-zinc-800/60 transition-colors"
                >
                  <StatusDot status={(t.status as string) || 'pending'} />
                  <span className="text-xs text-zinc-300 truncate flex-1">{String(t.prompt ?? '').slice(0, 80)}</span>
                  <span className="text-[10px] text-zinc-700 font-mono shrink-0">
                    {t.createdAt ? formatTime(t.createdAt as number) : ''}
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* Sessions (browse mode) */}
          {!isSearching && filteredSessions.length > 0 && (
            <div className="py-1 border-t border-zinc-800/60">
              <div className="px-4 py-1.5">
                <span className="text-[10px] text-zinc-600 uppercase tracking-wider font-medium">Claude Code sessions</span>
              </div>
              {filteredSessions.slice(0, 20).map(s => (
                <button
                  key={s.id}
                  onClick={() => { onSelect(`session:${s.id}`); onClose(); }}
                  className="flex items-center gap-2.5 w-full px-4 py-2 text-left hover:bg-zinc-800/60 transition-colors"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 shrink-0" />
                  <span className="text-xs text-zinc-400 truncate flex-1">{s.firstMessage}</span>
                  <span className="text-[10px] text-zinc-700 font-mono shrink-0">{s.messageCount}m</span>
                  <span className="text-[10px] text-zinc-700 font-mono shrink-0">{s.date.slice(5)}</span>
                </button>
              ))}
            </div>
          )}

          {/* Empty state */}
          {filteredTasks.length === 0 && filteredSessions.length === 0 && searchResults.length === 0 && (
            <div className="px-4 py-8 text-center text-xs text-zinc-600">
              {isSearching ? 'No matches found' : 'No tasks or sessions available'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Session column viewer ──

function SessionColumn({ sessionId, configPath }: { sessionId: string; configPath: string }) {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    execute(configPath, 'readSession', { sessionId, maxLength: 50000 }).then(r => {
      setText(typeof r === 'string' ? r : JSON.stringify(r));
      setLoading(false);
    });
  }, [sessionId, configPath]);

  if (loading) {
    return <div className="p-4 text-zinc-600 text-xs animate-pulse">Loading session {sessionId}...</div>;
  }

  const blocks = text.split(/\n\n(?=\[(?:user|assistant)\])/).filter(Boolean);

  return (
    <div className="flex flex-col gap-2 p-3 overflow-y-auto h-full">
      {blocks.map((block, i) => {
        const match = block.match(/^\[(user|assistant)\]\s*/);
        if (!match) return <pre key={i} className="text-[11px] text-zinc-500 whitespace-pre-wrap">{block}</pre>;

        const role = match[1];
        const content = block.slice(match[0].length);

        return (
          <div
            key={i}
            className={cn(
              'rounded-lg px-3 py-2',
              role === 'user'
                ? 'bg-zinc-800/80 text-zinc-300 ml-6'
                : 'bg-zinc-900/80 text-zinc-400 mr-4'
            )}
          >
            <span className={cn(
              'text-[9px] uppercase tracking-wider font-semibold mb-1 block',
              role === 'user' ? 'text-sky-500/70' : 'text-emerald-500/70'
            )}>
              {role}
            </span>
            <LogRenderer text={content} />
          </div>
        );
      })}
    </div>
  );
}

// ── Workspace Column ──

function WorkspaceColumn({ columnRef, configPath, onRemove }: {
  columnRef: string;
  configPath: string;
  onRemove: () => void;
}) {
  const isSession = columnRef.startsWith('session:');
  const sessionId = isSession ? columnRef.slice(8) : '';
  const node = usePath(isSession ? '' : columnRef);

  const label = isSession
    ? `session ${sessionId}`
    : (node ? String((node as Record<string, unknown>).prompt ?? '').slice(0, 40) || columnRef.split('/').at(-1) : columnRef.split('/').at(-1));

  const status = !isSession && node ? ((node as Record<string, unknown>).status as string) || 'pending' : '';

  return (
    <div className="flex-1 min-w-[340px] max-w-[50vw] flex flex-col border-r border-zinc-800 last:border-r-0">
      {/* Column header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-zinc-950 border-b border-zinc-800 shrink-0">
        {isSession ? (
          <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 shrink-0" />
        ) : (
          status && <StatusDot status={status} />
        )}
        <span className="text-[11px] text-zinc-400 truncate flex-1 font-mono">{label}</span>
        <button
          onClick={onRemove}
          className="text-zinc-700 hover:text-red-400 transition-colors duration-200 p-0.5"
          title="Remove column"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>

      {/* Column content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {isSession ? (
          <SessionColumn sessionId={sessionId} configPath={configPath} />
        ) : node ? (
          <Render value={node} />
        ) : (
          <div className="p-3 text-[11px] text-zinc-700 animate-pulse">Loading...</div>
        )}
      </div>
    </div>
  );
}

// ── Workspace View ──

const WorkspaceView: View<MetatronWorkspace> = ({ value, ctx }) => {
  const [showPicker, setShowPicker] = useState(false);
  const path = ctx!.path;
  const ws = usePath(path, MetatronWorkspace);

  const configPath = useMemo(() => path.replace(/\/workspaces\/[^/]+$/, ''), [path]);
  const columns = value.columns;

  const handleRemoveColumn = useCallback(async (taskPath: string) => {
    await ws.removeColumn({ taskPath });
  }, [ws]);

  const handleAddColumn = useCallback(async (ref: string) => {
    await ws.addColumn({ taskPath: ref });
  }, [ws]);

  const handleNewTask = useCallback(async (prompt: string) => {
    // task action is on config service, not a typed class method
    const result = await execute(configPath, 'task', { prompt });
    if (result && typeof result === 'object' && 'taskPath' in result) {
      await ws.addColumn({ taskPath: (result as { taskPath: string }).taskPath });
    }
  }, [configPath, ws]);

  if (columns.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 h-64">
        <div className="w-10 h-10 rounded-xl bg-zinc-800 flex items-center justify-center">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-zinc-600">
            <rect x="3" y="3" width="7" height="18" rx="1.5" /><rect x="14" y="3" width="7" height="18" rx="1.5" />
          </svg>
        </div>
        <div className="text-center">
          <h2 className="text-sm font-medium text-zinc-300">{String(value.name) || 'Workspace'}</h2>
          <p className="text-[11px] text-zinc-600 mt-0.5">Add columns to compare tasks side by side</p>
        </div>
        <button
          onClick={() => setShowPicker(true)}
          className="px-4 py-2 rounded-lg text-xs font-medium bg-violet-600 hover:bg-violet-500 text-white shadow-sm shadow-violet-600/20 transition-all duration-200"
        >
          Add column
        </button>
        {showPicker && (
          <CommandPicker
            configPath={configPath}
            exclude={columns}
            onSelect={handleAddColumn}
            onNewTask={handleNewTask}
            onClose={() => setShowPicker(false)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full w-full overflow-x-auto">
      {columns.map(ref => (
        <WorkspaceColumn
          key={ref}
          columnRef={ref}
          configPath={configPath}
          onRemove={() => handleRemoveColumn(ref)}
        />
      ))}

      {/* Add column button */}
      <div className="flex items-center justify-center w-12 shrink-0 border-l border-zinc-800/60">
        <button
          onClick={() => setShowPicker(true)}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-700 hover:text-violet-400 hover:bg-violet-500/10 transition-all duration-200"
          title="Add column"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14"/></svg>
        </button>
      </div>

      {showPicker && (
        <CommandPicker
          configPath={configPath}
          exclude={columns}
          onSelect={handleAddColumn}
          onNewTask={handleNewTask}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}

register('metatron.workspace', 'react', WorkspaceView);
