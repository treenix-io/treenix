import { register } from '@treenity/core';
import { type View } from '@treenity/react/context';
import { execute } from '@treenity/react/hooks';
import { cn } from '@treenity/react/lib/utils';
import { useCallback, useEffect, useState } from 'react';

import type { MetatronTask } from '../types';
import { LogRenderer, Md } from './log';
import { formatTime, StatusBadge, StatusDot } from './shared';

// ── Stop button ──

function StopButton({ taskPath }: { taskPath: string }) {
  const [stopping, setStopping] = useState(false);

  const handleStop = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    setStopping(true);
    try {
      await execute(taskPath, 'stop', {});
    } finally {
      setStopping(false);
    }
  }, [taskPath]);

  return (
    <button
      onClick={handleStop}
      disabled={stopping}
      className="w-5 h-5 rounded flex items-center justify-center bg-red-500/15 hover:bg-red-500/25 transition-all duration-150 shrink-0"
      title="Stop task"
    >
      <span className={cn('w-2 h-2 rounded-[1px] bg-red-400', stopping && 'opacity-50')} />
    </button>
  );
}

// ── Inject input ──

function InjectInput({ taskPath }: { taskPath: string }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  const handleSend = useCallback(async () => {
    const t = text.trim();
    if (!t) return;
    setSending(true);
    try {
      await execute(taskPath, 'inject', { text: t });
      setText('');
    } finally {
      setSending(false);
    }
  }, [text, taskPath]);

  return (
    <div className="mt-2 pt-2 border-t border-zinc-800/40">
      <div className="relative">
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSend(); }}
          rows={1}
          placeholder="Queue a follow-up message..."
          className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 pr-16 text-xs text-zinc-200 resize-none focus:outline-none focus:border-violet-600/50 placeholder:text-zinc-700"
        />
        <button
          onClick={handleSend}
          disabled={sending || !text.trim()}
          className={cn(
            'absolute right-1.5 bottom-1.5 px-2.5 py-1 rounded-md text-[10px] font-semibold transition-all duration-150',
            text.trim()
              ? 'bg-amber-600 hover:bg-amber-500 text-white'
              : 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
          )}
        >
          {sending ? '...' : 'Queue'}
        </button>
      </div>
    </div>
  );
}

// ── Task row (used in config lists) ──

export function TaskRow({ task }: { task: Record<string, unknown> }) {
  const status = (task.status as string) || 'pending';
  const isRunning = status === 'running';
  const isActive = isRunning || status === 'done';
  const [expanded, setExpanded] = useState(isActive);
  const prompt = (task.prompt as string) || '';
  const result = (task.result as string) || '';
  const taskLog = (task.log as string) || '';
  const hasLog = !!taskLog;
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
        {isRunning && <StopButton taskPath={task.$path as string} />}
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
                  tab === t
                    ? 'bg-zinc-800 text-zinc-200'
                    : 'text-zinc-600 hover:text-zinc-400'
                )}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            <LogRenderer text={tab === 'result' ? (result || 'No result yet') : (taskLog || result || 'No log yet')} />
          </div>

          {isRunning && <InjectInput taskPath={task.$path as string} />}
        </div>
      )}
    </div>
  );
}

// ── Running indicator — animated ping ──

function RunningPing({ color = 'sky' }: { color?: 'sky' | 'emerald' | 'amber' }) {
  const colors = {
    sky: { ping: 'bg-sky-400', dot: 'bg-sky-500 shadow-sky-500/50' },
    emerald: { ping: 'bg-emerald-400', dot: 'bg-emerald-500 shadow-emerald-500/50' },
    amber: { ping: 'bg-amber-400', dot: 'bg-amber-500 shadow-amber-500/50' },
  };
  const c = colors[color];
  return (
    <span className="relative flex h-3 w-3 shrink-0">
      <span className={cn('animate-ping absolute inline-flex h-full w-full rounded-full opacity-75', c.ping)} />
      <span className={cn('relative inline-flex h-3 w-3 rounded-full shadow-lg', c.dot)} />
    </span>
  );
}

// ── Elapsed time hook ──
// XXX: should be two different operations, n ot one. use elapset return just number, and then it formatted as wanted
function useElapsed(startTs: number, active: boolean): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active || !startTs) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active, startTs]);

  if (!startTs) return '';
  const s = Math.floor(((active ? now : Date.now()) - startTs) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// ── Task view (individual task page /t/.../tasks/xxx) ──

const TaskView: View<MetatronTask> = ({ value, ctx }) => {
  const path = ctx!.path;
  const status = value.status || 'pending';
  const isRunning = status === 'running';
  const result = value.result || '';
  const taskLog = value.log || '';
  const [tab, setTab] = useState<'result' | 'log'>(taskLog ? 'log' : 'result');
  const elapsed = useElapsed(value.createdAt, isRunning);

  return (
    <div className="flex flex-col gap-5 p-5 max-w-4xl">

      {/* ── Header ── */}
      <div className="flex items-center gap-3">
        {isRunning ? <RunningPing /> : <StatusDot status={status} />}
        <StatusBadge status={status} />

        <div className="flex items-center gap-2 ml-auto">
          {elapsed && (
            <span className={cn(
              'text-[10px] font-mono tabular-nums',
              isRunning ? 'text-sky-400/70' : 'text-zinc-600',
            )}>
              {elapsed}
            </span>
          )}
          <span className="text-[10px] text-zinc-600 font-mono tabular-nums">
            {value.createdAt ? formatTime(value.createdAt) : ''}
          </span>
          {isRunning && <StopButton taskPath={path} />}
        </div>
      </div>

      {/* ── Prompt ── */}
      <div className="bg-zinc-900/40 rounded-xl px-4 py-3 border border-zinc-800/40">
        <Md className="text-sm text-zinc-300 leading-relaxed" text={value.prompt} />
      </div>

      {/* ── Tabs ── */}
      <div className="flex gap-0.5 bg-zinc-900/40 rounded-lg p-0.5 w-fit">
        {(['log', 'result'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              'px-3.5 py-1 rounded-md text-xs font-medium transition-all duration-150',
              tab === t
                ? 'bg-zinc-800 text-zinc-200 shadow-sm'
                : 'text-zinc-500 hover:text-zinc-300',
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {/* ── Log / Result ── */}
      <div className={cn(
        'rounded-xl px-3 py-2.5 max-h-[75vh] overflow-y-auto border transition-all duration-300',
        isRunning
          ? 'bg-zinc-950 border-sky-500/15 shadow-lg shadow-sky-500/5'
          : 'bg-zinc-950 border-zinc-800',
      )}>
        <LogRenderer text={tab === 'result' ? (result || 'No result yet') : (taskLog || result || 'No log yet')} />
      </div>

      {isRunning && <InjectInput taskPath={path} />}
    </div>
  );
};

register('metatron.task', 'react', TaskView);
