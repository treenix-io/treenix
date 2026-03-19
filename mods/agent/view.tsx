// Agent Office — views for ai.pool, ai.agent, ai.approval, ai.thread

import { MetatronConfig } from '#metatron/types';
import { getComponent, register } from '@treenity/core';
import { Render, RenderContext, type View } from '@treenity/react/context';
import { execute, useChildren, useNavigate, usePath } from '@treenity/react/hooks';
import { minimd } from '@treenity/react/lib/minimd';
import { cn } from '@treenity/react/lib/utils';
import { useMemo, useState } from 'react';
import { AiApproval } from './guardian';
import { type AgentStatus, AiAgent, AiApprovals, AiPlan, AiPool, AiThread } from './types';

// ── Status styling ──

type StatusStyle = { bg: string; text: string; dot: string; label: string };

const AGENT_STATUS: Record<AgentStatus, StatusStyle> = {
  idle:    { bg: 'bg-emerald-500/10', text: 'text-emerald-400', dot: 'bg-emerald-400', label: 'idle' },
  working: { bg: 'bg-sky-500/10', text: 'text-sky-400', dot: 'bg-sky-400 animate-pulse', label: 'working' },
  blocked: { bg: 'bg-amber-500/10', text: 'text-amber-400', dot: 'bg-amber-400', label: 'blocked' },
  error:   { bg: 'bg-red-500/10', text: 'text-red-400', dot: 'bg-red-400', label: 'error' },
  offline: { bg: 'bg-zinc-700/20', text: 'text-zinc-500', dot: 'bg-zinc-600', label: 'offline' },
};

const APPROVAL_STATUS: Record<string, { bg: string; text: string; border: string }> = {
  pending:  { bg: 'bg-amber-500/10', text: 'text-amber-400', border: 'border-amber-500/30' },
  approved: { bg: 'bg-emerald-500/10', text: 'text-emerald-400', border: 'border-emerald-500/30' },
  denied:   { bg: 'bg-red-500/10', text: 'text-red-400', border: 'border-red-500/30' },
};

function timeAgo(ts: number): string {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60_000) return 'just now';
  if (d < 3600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86400_000) return `${Math.floor(d / 3600_000)}h ago`;
  return new Date(ts).toLocaleDateString('en', { month: 'short', day: 'numeric' });
}

function statusStyle(status: string): StatusStyle {
  return AGENT_STATUS[status as AgentStatus] ?? AGENT_STATUS.offline;
}

function StatusDot({ status }: { status: string }) {
  return <span className={cn('inline-block w-2 h-2 rounded-full', statusStyle(status).dot)} />;
}

// ── PoolView (ai.pool — dashboard) ──

const PoolView: View<AiPool> = ({ value, ctx }) => {
  const path = ctx!.node.$path;
  const agents = useChildren(path);
  const approvals = useChildren(path + '/approvals');

  const agentNodes = (agents ?? []).filter(n => n.$type === 'ai.agent');
  const approvalNodes = (approvals ?? []).filter(n => n.$type === 'ai.approval');
  const pendingApprovals = approvalNodes.filter(n => n.status === 'pending');

  const activeCount = value.active?.length ?? 0;
  const queueCount = value.queue?.length ?? 0;
  const maxC = value.maxConcurrent ?? 2;

  return (
    <div className="flex flex-col gap-6 p-5 max-w-3xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100 tracking-tight">Agent Office</h2>
          <p className="text-xs text-zinc-500 mt-0.5 font-mono">
            {activeCount}/{maxC} active · {queueCount} queued
          </p>
        </div>

        {/* Pool capacity bar */}
        <div className="flex gap-1">
          {Array.from({ length: maxC }, (_, i) => (
            <div
              key={i}
              className={cn(
                'w-3 h-8 rounded-sm transition-colors duration-300',
                i < activeCount ? 'bg-sky-500/60' : 'bg-zinc-800',
              )}
            />
          ))}
        </div>
      </div>

      {/* Pending approvals */}
      {pendingApprovals.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-[11px] font-medium text-amber-400 uppercase tracking-wider">
            Pending Approvals ({pendingApprovals.length})
          </h3>
          {pendingApprovals.map((a) => (
            <Render key={a.$path} value={a} />
          ))}
        </div>
      )}

      {/* Agents grid */}
      <div className="flex flex-col gap-2">
        <h3 className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider">
          Agents ({agentNodes.length})
        </h3>
        <RenderContext name="react:list">
          {agentNodes.map((agent) => (
            <Render key={agent.$path} value={agent} />
          ))}
        </RenderContext>
        {agentNodes.length === 0 && (
          <p className="text-sm text-zinc-600 italic">No agents registered</p>
        )}
      </div>
    </div>
  );
};

// ── AgentRow (compact card — react:list context) ──

const AgentRow: View<AiAgent> = ({ value, ctx }) => {
  const nav = useNavigate();
  const status = value.status || 'offline';
  const s = statusStyle(status);

  return (
    <button
      onClick={() => nav(ctx!.node.$path)}
      className={cn(
        'flex items-center gap-3 px-3.5 py-2.5 rounded-lg border transition-all duration-150',
        'border-zinc-800/60 hover:border-zinc-700 hover:bg-zinc-800/30',
        'text-left w-full group',
      )}
    >
      <StatusDot status={status} />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-zinc-200 truncate">
            {ctx!.node.$path.split('/').at(-1)}
          </span>
          <span className={cn('text-[10px] font-mono px-1.5 py-0.5 rounded', s.bg, s.text)}>
            {value.role}
          </span>
        </div>

        {status === 'working' && value.currentTask && (
          <p className="text-[11px] text-zinc-500 truncate mt-0.5 font-mono">
            → {value.currentTask}
          </p>
        )}
      </div>

      <div className="flex items-center gap-3 text-[11px] text-zinc-600">
        {value.totalTokens > 0 && (
          <span className="font-mono">{(value.totalTokens / 100000).toFixed(2)}$</span>
        )}
        {value.lastRunAt > 0 && <span>{timeAgo(value.lastRunAt)}</span>}
      </div>

      <span className="text-zinc-700 group-hover:text-zinc-500 transition-colors">›</span>
    </button>
  );
};

// ── AgentView (ai.agent detail) ──

const AgentView: View<AiAgent> = ({ value, ctx }) => {
  const path = ctx!.node.$path;
  const status = value.status || 'offline';
  const s = statusStyle(status);
  const config = getComponent(ctx!.node, MetatronConfig);
  const mtTask = usePath(value.taskRef || null);

  return (
    <div className="flex flex-col gap-5 p-5 max-w-2xl">
      <div className="flex items-center gap-3">
        <StatusDot status={status} />
        <h2 className="text-lg font-semibold text-zinc-100">{path.split('/').at(-1)}</h2>
        <span className={cn('text-xs font-mono px-2 py-0.5 rounded', s.bg, s.text)}>
          {s.label}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <InfoCell label="Role" value={value.role} />
        <InfoCell label="Model" value={config?.model || '—'} mono />
        <InfoCell label="Last Run" value={value.lastRunAt ? timeAgo(value.lastRunAt) : 'never'} />
        <InfoCell label="Tokens" value={value.totalTokens > 0 ? `$${(value.totalTokens / 100000).toFixed(3)}` : '—'} mono />
        {value.currentTask && <InfoCell label="Current Task" value={value.currentTask} mono span2 />}
      </div>

      {config?.systemPrompt && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider">System Prompt</span>
          <pre className="text-xs text-zinc-400 bg-zinc-900/50 border border-zinc-800 rounded-lg p-3 whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto">
            {config.systemPrompt}
          </pre>
        </div>
      )}

      {/* Live metatron.task log (D29) */}
      {mtTask && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-sky-400 uppercase tracking-wider">Live Task</span>
          <Render value={mtTask} />
        </div>
      )}

      <div className="flex gap-2 pt-2">
        {status === 'offline' && (
          <ActionBtn label="Bring Online" color="emerald" onClick={() => execute(path, 'online')} />
        )}
        {status === 'idle' && (
          <ActionBtn label="Take Offline" color="zinc" onClick={() => execute(path, 'offline')} />
        )}
        {status === 'error' && (
          <ActionBtn label="Bring Online" color="emerald" onClick={() => execute(path, 'online')} />
        )}
      </div>
    </div>
  );
};

function InfoCell({ label, value, mono, span2 }: { label: string; value: string; mono?: boolean; span2?: boolean }) {
  return (
    <div className={cn('bg-zinc-900/40 border border-zinc-800/50 rounded-lg px-3 py-2', span2 && 'col-span-2')}>
      <span className="text-[10px] text-zinc-600 uppercase tracking-wider block">{label}</span>
      <span className={cn('text-sm text-zinc-300 mt-0.5 block truncate', mono && 'font-mono text-xs')}>{value}</span>
    </div>
  );
}

function ActionBtn({ label, color, onClick }: { label: string; color: string; onClick: () => void }) {
  const colors: Record<string, string> = {
    emerald: 'bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/30 border-emerald-500/20',
    zinc: 'bg-zinc-700/30 text-zinc-400 hover:bg-zinc-700/50 border-zinc-600/20',
    red: 'bg-red-600/20 text-red-400 hover:bg-red-600/30 border-red-500/20',
  };
  return (
    <button
      onClick={onClick}
      className={cn('px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors', colors[color] ?? colors.zinc)}
    >
      {label}
    </button>
  );
}

// ── ApprovalsView (ai.approvals — container) ──

const ApprovalsView: View<AiApprovals> = ({ value, ctx }) => {
  const children = useChildren(ctx!.node.$path, { watch: true, watchNew: true });
  const pending = children.filter(n => n.$type === 'ai.approval' && n.status === 'pending');
  const resolved = children.filter(n => n.$type === 'ai.approval' && n.status !== 'pending');

  return (
    <div className="flex flex-col gap-5 p-5 max-w-3xl">
      <h2 className="text-lg font-semibold text-zinc-100 tracking-tight">Approvals</h2>

      {pending.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-[11px] font-medium text-amber-400 uppercase tracking-wider">
            Pending ({pending.length})
          </h3>
          {pending.map(a => <Render key={a.$path} value={a} />)}
        </div>
      )}

      {pending.length === 0 && (
        <p className="text-sm text-zinc-600 italic">No pending approvals</p>
      )}

      {resolved.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-[11px] font-medium text-zinc-600 uppercase tracking-wider">
            History ({resolved.length})
          </h3>
          {resolved.slice(0, 20).map(a => <Render key={a.$path} value={a} />)}
        </div>
      )}
    </div>
  );
}

// ── ApprovalView (ai.approval) ──

const ApprovalView: View<AiApproval> = ({ value, ctx }) => {
  const path = ctx!.node.$path;
  const status = value.status || 'pending';
  const s = APPROVAL_STATUS[status] ?? APPROVAL_STATUS.pending;
  const isPending = status === 'pending';

  return (
    <div className={cn('border rounded-lg px-4 py-3 flex flex-col gap-2', s.border, s.bg)}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={cn('text-xs font-medium', s.text)}>{status}</span>
          <span className="text-[11px] text-zinc-500 font-mono">{value.agentRole}</span>
          <span className="text-[11px] text-zinc-600">→</span>
          <span className="text-[11px] text-zinc-400 font-mono">{value.tool}</span>
        </div>
        <span className="text-[10px] text-zinc-600">{timeAgo(value.createdAt)}</span>
      </div>

      {value.input && (
        <pre className="text-[11px] text-zinc-500 bg-black/20 rounded px-2 py-1 max-h-20 overflow-y-auto whitespace-pre-wrap">
          {value.input}
        </pre>
      )}
      {value.reason && <p className="text-[11px] text-zinc-500 italic">{value.reason}</p>}

      {isPending && (
        <div className="flex items-center gap-2 pt-1 flex-wrap">
          <ActionBtn label="Approve" color="emerald" onClick={() => execute(path, 'approve')} />
          <ActionBtn label="Deny" color="red" onClick={() => execute(path, 'deny')} />
          <span className="text-[10px] text-zinc-700 mx-1">|</span>
          <ActionBtn label="Approve + remember (agent)" color="emerald" onClick={() => execute(path, 'approve', { remember: 'agent' })} />
          <ActionBtn label="Approve + remember (global)" color="emerald" onClick={() => execute(path, 'approve', { remember: 'global' })} />
        </div>
      )}
    </div>
  );
};

// ── ThreadView (ai.thread — message list) ──

const ThreadView: View<AiThread> = ({ value }) => {
  const messages = value?.messages ?? [];

  if (!messages.length) {
    return <p className="text-sm text-zinc-600 italic p-4">No messages yet</p>;
  }

  return (
    <div className="flex flex-col gap-1 p-4">
      {messages.map((msg, i) => (
        <div key={i} className="flex gap-2 py-1.5 group">
          <span className="text-[11px] font-mono text-sky-500/70 w-16 shrink-0 text-right pt-0.5">
            {msg.role}
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">{msg.text}</p>
            <span className="text-[10px] text-zinc-700 opacity-0 group-hover:opacity-100 transition-opacity">
              {msg.from} · {timeAgo(msg.ts)}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
};

// ── PlanView (ai.plan — approve/reject) ──

const PlanView: View<AiPlan> = ({ value, ctx }) => {
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const html = useMemo(() => value.text ? minimd(value.text) : '', [value.text]);

  if (!value.text && !value.feedback) return null;

  const doAction = async (action: 'approvePlan' | 'rejectPlan') => {
    if (!ctx) return;
    setBusy(true);
    try {
      await ctx.execute(action, feedback.trim() ? { feedback: feedback.trim() } : undefined);
      setFeedback('');
    } finally {
      setBusy(false);
    }
  };

  if (value.approved) {
    return (
      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
        <div className="mb-1 text-[11px] font-medium text-emerald-400 uppercase tracking-wider">Plan approved</div>
        <div className="minimd max-h-40 overflow-y-auto text-sm text-zinc-300" dangerouslySetInnerHTML={{ __html: html }} />
        {value.feedback && (
          <div className="mt-2 border-t border-emerald-500/20 pt-2 text-xs text-zinc-500">
            Feedback: {value.feedback}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-medium text-amber-400 uppercase tracking-wider">Plan awaiting approval</span>
        <span className="text-[10px] text-zinc-600">
          {value.createdAt ? new Date(value.createdAt).toLocaleString() : ''}
        </span>
      </div>

      <div
        className="minimd mb-3 max-h-60 overflow-y-auto rounded border border-zinc-800 bg-zinc-900/50 p-2 text-sm text-zinc-300"
        dangerouslySetInnerHTML={{ __html: html }}
      />

      {value.feedback && (
        <div className="mb-2 rounded border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-300">
          <span className="font-medium text-red-400">Rejection feedback:</span> {value.feedback}
        </div>
      )}

      <textarea
        value={feedback}
        onChange={e => setFeedback(e.target.value)}
        placeholder="Feedback / comments (optional)..."
        className="mb-2 w-full min-h-16 max-h-32 resize-none rounded border border-zinc-800 bg-zinc-900/50 p-2 text-sm text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-700"
      />

      <div className="flex items-center gap-2">
        <ActionBtn label="Approve Plan" color="emerald" onClick={() => doAction('approvePlan')} />
        <ActionBtn label="Reject" color="red" onClick={() => doAction('rejectPlan')} />
        {busy && <span className="text-[10px] text-zinc-600">sending...</span>}
      </div>
    </div>
  );
};

// ── Register views ──

register(AiPool, 'react', PoolView);
register(AiAgent, 'react', AgentView);
register(AiAgent, 'react:list', AgentRow);
register(AiApproval, 'react', ApprovalView);
register(AiApprovals, 'react', ApprovalsView);
register(AiThread, 'react', ThreadView);
register(AiPlan, 'react', PlanView);
