// ai.run view — structured log with ECS components

import { getComponent, register } from '@treenx/core';
import { type View } from '@treenx/react';
import { execute, useNavigate } from '@treenx/react';
import { cn } from '@treenx/react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { AiCost, AiLog, AiRun, AiRunStatus, type LogEntry } from '../types';
import { CollapsibleBlock, LogRenderer, Md } from './log';
import { formatTime, StatusBadge, StatusDot } from './shared';

// ── Stop button ──

function StopButton({ runPath }: { runPath: string }) {
  const [stopping, setStopping] = useState(false);

  const handleStop = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    setStopping(true);
    try {
      await execute(runPath, 'stop', {});
    } finally {
      setStopping(false);
    }
  }, [runPath]);

  return (
    <button
      onClick={handleStop}
      disabled={stopping}
      className="w-5 h-5 rounded flex items-center justify-center bg-red-500/15 hover:bg-red-500/25 transition-all duration-150 shrink-0"
      title="Stop run"
    >
      <span className={cn('w-2 h-2 rounded-[1px] bg-red-400', stopping && 'opacity-50')} />
    </button>
  );
}

// ── Running indicator ──

function RunningPing() {
  return (
    <span className="relative flex h-3 w-3 shrink-0">
      <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 bg-sky-400" />
      <span className="relative inline-flex h-3 w-3 rounded-full shadow-lg bg-sky-500 shadow-sky-500/50" />
    </span>
  );
}

// ── Elapsed time ──

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

// ── Structured log renderer (from LogEntry[]) ──

function StructuredLogRenderer({ entries, className }: { entries: LogEntry[]; className?: string }) {
  // Convert structured entries back to text format for the existing LogRenderer
  // TODO: build native structured renderer that avoids double conversion
  const text = useMemo(() => {
    if (!entries?.length) return '';
    return entries.map(e => {
      switch (e.type) {
        case 'text': return e.output ?? '';
        case 'tool_call': return `\n[tool] ${e.tool}\n${JSON.stringify(e.input, null, 2)}\n`;
        case 'tool_result': return `\n[result] ${e.output}\n`;
        case 'thinking': return `\n[thinking]\n${e.output}\n`;
        case 'approval': return `\n[approval] ${e.tool} → ${e.approved ? 'approved' : 'denied'}\n`;
        case 'embed': return e.ref ? `\n[embed] ${e.ref}\n` : '';
        default: return '';
      }
    }).join('');
  }, [entries]);

  return <LogRenderer text={text} className={className} />;
}

// ── Run view ──

const RunView: View<AiRun> = ({ value, ctx }) => {
  const path = ctx!.path;
  const node = ctx!.node;

  const runStatus = getComponent(node, AiRunStatus);
  const logComp = getComponent(node, AiLog);
  const costComp = getComponent(node, AiCost);

  const status = runStatus?.status ?? 'pending';
  const isRunning = status === 'running';
  const entries = logComp?.entries ?? [];
  const [tab, setTab] = useState<'log' | 'result'>(entries.length ? 'log' : 'result');
  const elapsed = useElapsed(runStatus?.startedAt ?? 0, isRunning);

  return (
    <div className="flex flex-col gap-5 p-5 max-w-4xl">

      {/* Header */}
      <div className="flex items-center gap-3">
        {isRunning ? <RunningPing /> : <StatusDot status={status} />}
        <StatusBadge status={status} />
        <span className={cn(
          'text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400',
        )}>
          {value.mode}
        </span>

        <div className="flex items-center gap-2 ml-auto">
          {elapsed && (
            <span className={cn(
              'text-[10px] font-mono tabular-nums',
              isRunning ? 'text-sky-400/70' : 'text-zinc-600',
            )}>
              {elapsed}
            </span>
          )}
          {costComp && costComp.costUsd > 0 && (
            <span className="text-[10px] font-mono text-zinc-600">
              ${costComp.costUsd.toFixed(3)}
            </span>
          )}
          <span className="text-[10px] text-zinc-600 font-mono tabular-nums">
            {runStatus?.startedAt ? formatTime(runStatus.startedAt) : ''}
          </span>
          {isRunning && <StopButton runPath={path} />}
        </div>
      </div>

      {/* Task ref */}
      {value.taskRef && (
        <div className="text-[11px] text-zinc-500 font-mono">
          task: {value.taskRef}
        </div>
      )}

      {/* Prompt */}
      <div className="bg-zinc-900/40 rounded-xl px-4 py-3 border border-zinc-800/40">
        <CollapsibleBlock
          label={<span className="text-zinc-400">Prompt</span>}
          labelClass="text-zinc-400/80 hover:text-zinc-300"
          wrap={true}
          defaultOpen={false}
        >
          <Md text={value.prompt} className="text-sm text-zinc-300" />
        </CollapsibleBlock>
      </div>

      {/* Tabs */}
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
            {t === 'log' ? `log (${entries.length})` : t}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className={cn(
        'rounded-xl px-3 py-2.5 max-h-[75vh] overflow-y-auto border transition-all duration-300',
        isRunning
          ? 'bg-zinc-950 border-sky-500/15 shadow-lg shadow-sky-500/5'
          : 'bg-zinc-950 border-zinc-800',
      )}>
        {tab === 'log'
          ? <StructuredLogRenderer entries={entries} />
          : <p className="text-sm text-zinc-300 whitespace-pre-wrap">{value.result || 'No result yet'}</p>
        }
      </div>

      {/* Error */}
      {runStatus?.error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-300">
          {runStatus.error}
        </div>
      )}
    </div>
  );
};

// ── Run row (compact — react:list) ──

const RunRow: View<AiRun> = ({ value, ctx }) => {
  const nav = useNavigate();
  const node = ctx!.node;
  const runStatus = getComponent(node, AiRunStatus);
  const costComp = getComponent(node, AiCost);
  const status = runStatus?.status ?? 'pending';

  return (
    <button
      onClick={() => nav(ctx!.path)}
      className={cn(
        'flex items-center gap-2.5 px-3.5 py-2 rounded-lg border transition-colors text-left w-full',
        'border-zinc-800/60 hover:border-zinc-700 hover:bg-zinc-800/30',
      )}>
      <StatusDot status={status} />
      <span className={cn(
        'text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-800/60 text-zinc-500',
      )}>
        {value.mode}
      </span>
      <span className="text-sm text-zinc-300 truncate flex-1">
        {value.prompt.slice(0, 80) || '(no prompt)'}
      </span>
      {costComp && costComp.costUsd > 0 && (
        <span className="text-[10px] font-mono text-zinc-600">${costComp.costUsd.toFixed(3)}</span>
      )}
      {runStatus?.startedAt ? (
        <span className="text-[10px] text-zinc-600 shrink-0">{formatTime(runStatus.startedAt)}</span>
      ) : null}
    </button>
  );
};

register(AiRun, 'react', RunView);
register(AiRun, 'react:list', RunRow);
