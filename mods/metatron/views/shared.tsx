import { cn } from '@treenx/react';
import dayjs from 'dayjs';

// ── Design tokens ──

export const STATUS: Record<string, { bg: string; text: string; dot: string }> = {
  pending:  { bg: 'bg-amber-500/15', text: 'text-amber-400', dot: 'bg-amber-400' },
  running:  { bg: 'bg-sky-500/15', text: 'text-sky-400', dot: 'bg-sky-400 animate-pulse' },
  done:     { bg: 'bg-emerald-500/15', text: 'text-emerald-400', dot: 'bg-emerald-400' },
  error:    { bg: 'bg-red-500/15', text: 'text-red-400', dot: 'bg-red-400' },
};

export function formatTime(ts: number): string {
  if (!ts) return '';
  const d = dayjs(ts);
  const now = dayjs();

  // Same day — just time
  if (d.isSame(now, 'day')) return d.format('HH:mm');

  // This year — date + time
  if (d.isSame(now, 'year')) return d.format('MMM D HH:mm');

  // Different year
  return d.format('MMM D YYYY HH:mm');
}

export function StatusDot({ status }: { status: string }) {
  const s = STATUS[status] || STATUS.pending;
  return <span className={cn('inline-block w-1.5 h-1.5 rounded-full shrink-0', s.dot)} />;
}

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] || STATUS.pending;
  return (
    <span className={cn('px-2 py-0.5 rounded-full text-[10px] font-semibold tracking-wide uppercase', s.bg, s.text)}>
      {status}
    </span>
  );
}
