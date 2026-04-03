// Universal component views — compact, embeddable in any node

import { type NodeData, register } from '@treenity/core';
import { type Actions, type View, useActions } from '@treenity/react/context';
import { trpc } from '@treenity/react/trpc';
import { cn } from '@treenity/react/lib/utils';
import { Button } from '@treenity/react/ui/button';
import { Input } from '@treenity/react/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@treenity/react/ui/select';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ATTACHABLE_COMPONENTS, TChecklist, TComments, TEstimate, TLinks, TTags, TTimeTrack } from './types';

// ── Section wrapper ──

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
      <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

// ── Checklist ──

const ChecklistView: View<TChecklist> = ({ value }) => {
  const actions = useActions(value);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const items = Array.isArray(value.items) ? value.items.filter(Boolean) : [];
  const doneCount = items.filter(i => i.done).length;

  return (
    <Section label={`Checklist${items.length ? ` (${doneCount}/${items.length})` : ''}`}>
      {items.length > 0 && (
        <div className="mb-2 h-1 rounded-full bg-white/5">
          <div
            className="h-1 rounded-full bg-emerald-500 transition-all"
            style={{ width: `${items.length ? (doneCount / items.length) * 100 : 0}%` }}
          />
        </div>
      )}

      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item.id} className="group flex items-center gap-2 rounded px-1 py-0.5 hover:bg-white/[0.04]">
            <button
              className={cn(
                'flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px]',
                item.done ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-zinc-600',
              )}
              onClick={() => actions.toggle({ id: item.id })}
            >
              {item.done ? '✓' : ''}
            </button>
            <span className={cn('flex-1 text-sm', item.done && 'text-muted-foreground line-through')}>{item.text}</span>
            <button
              className="hidden text-xs text-muted-foreground hover:text-destructive group-hover:block"
              onClick={() => actions.remove({ id: item.id })}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>

      <form
        className="mt-2 flex gap-1.5"
        onSubmit={e => {
          e.preventDefault();
          if (!draft.trim()) return;
          actions.add({ text: draft });
          setDraft('');
          inputRef.current?.focus();
        }}
      >
        <Input
          ref={inputRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder="Add item..."
          className="h-7 flex-1 text-xs"
        />
        <Button type="submit" size="sm" variant="ghost" className="h-7 px-2 text-xs">+</Button>
      </form>
    </Section>
  );
};

register(TChecklist, 'react', ChecklistView);

// ── Tags ──

const TAG_COLORS = [
  'bg-blue-500/20 text-blue-300',
  'bg-emerald-500/20 text-emerald-300',
  'bg-amber-500/20 text-amber-300',
  'bg-purple-500/20 text-purple-300',
  'bg-pink-500/20 text-pink-300',
  'bg-cyan-500/20 text-cyan-300',
  'bg-orange-500/20 text-orange-300',
  'bg-red-500/20 text-red-300',
];

function tagColor(tag: string) {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) hash = ((hash << 5) - hash + tag.charCodeAt(i)) | 0;
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
}

const TagsView: View<TTags> = ({ value }) => {
  const actions = useActions(value);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const items = Array.isArray(value.items) ? value.items : [];

  return (
    <Section label="Tags">
      <div className="flex flex-wrap gap-1.5">
        {items.map(tag => (
          <span key={tag} className={cn('group inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', tagColor(tag))}>
            {tag}
            <button className="hidden hover:text-white group-hover:inline" onClick={() => actions.remove({ tag })}>
              ✕
            </button>
          </span>
        ))}

        {!adding && (
          <button
            className="rounded-full border border-dashed border-zinc-600 px-2 py-0.5 text-xs text-muted-foreground hover:border-zinc-400 hover:text-foreground"
            onClick={() => setAdding(true)}
          >
            +
          </button>
        )}

        {adding && (
          <form
            className="inline-flex"
            onSubmit={e => {
              e.preventDefault();
              if (draft.trim()) actions.add({ tag: draft });
              setDraft('');
              setAdding(false);
            }}
          >
            <Input
              autoFocus
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onBlur={() => {
                if (draft.trim()) actions.add({ tag: draft });
                setDraft('');
                setAdding(false);
              }}
              placeholder="tag..."
              className="h-6 w-24 text-xs"
            />
          </form>
        )}
      </div>
    </Section>
  );
};

register(TTags, 'react', TagsView);

// ── Estimate ──

const UNIT_LABELS: Record<string, string> = { hours: 'h', points: 'pts', days: 'd' };

const EstimateView: View<TEstimate> = ({ value }) => {
  const actions = useActions(value);
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [draftUnit, setDraftUnit] = useState(typeof value.unit === 'string' ? value.unit : 'hours');
  const v = typeof value.value === 'number' ? value.value : 0;
  const unit = typeof value.unit === 'string' ? value.unit : 'hours';

  if (editing) {
    const save = () => {
      const num = parseFloat(inputRef.current?.value ?? '0');
      if (!isNaN(num) && num >= 0) actions.update({ value: num, unit: draftUnit });
      setEditing(false);
    };

    return (
      <Section label="Estimate">
        <div className="flex items-center gap-2">
          <Input
            ref={inputRef}
            autoFocus
            type="number"
            min={0}
            step={0.5}
            defaultValue={v}
            className="h-7 w-20 text-xs"
            onKeyDown={e => { if (e.key === 'Enter') save(); }}
          />
          <Select value={draftUnit} onValueChange={setDraftUnit}>
            <SelectTrigger className="h-7 w-24 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="hours">Hours</SelectItem>
              <SelectItem value="points">Points</SelectItem>
              <SelectItem value="days">Days</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={save}>OK</Button>
        </div>
      </Section>
    );
  }

  return (
    <Section label="Estimate">
      <button
        className="rounded bg-white/5 px-2 py-1 text-sm font-medium hover:bg-white/10"
        onClick={() => setEditing(true)}
      >
        {v > 0 ? `${v}${UNIT_LABELS[unit] || unit}` : 'Set estimate...'}
      </button>
    </Section>
  );
};

register(TEstimate, 'react', EstimateView);

// ── Links ──

const LinksView: View<TLinks> = ({ value }) => {
  const actions = useActions(value);
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const items = Array.isArray(value.items) ? value.items : [];

  return (
    <Section label="Links">
      <ul className="space-y-1">
        {items.map((link) => (
          <li key={link.id} className="group flex items-center gap-2">
            <a
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 truncate text-sm text-blue-400 hover:underline"
              onClick={e => e.stopPropagation()}
            >
              {link.label || link.url}
            </a>
            <button className="hidden text-xs text-muted-foreground hover:text-destructive group-hover:block" onClick={() => actions.remove({ id: link.id })}>
              ✕
            </button>
          </li>
        ))}
      </ul>

      {!adding && (
        <button
          className="mt-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setAdding(true)}
        >
          + Add link
        </button>
      )}

      {adding && (
        <form
          className="mt-2 flex flex-col gap-1.5"
          onSubmit={e => {
            e.preventDefault();
            if (url.trim()) actions.add({ url, label });
            setUrl('');
            setLabel('');
            setAdding(false);
          }}
        >
          <Input autoFocus value={url} onChange={e => setUrl(e.target.value)} placeholder="https://..." className="h-7 text-xs" />
          <div className="flex gap-1.5">
            <Input value={label} onChange={e => setLabel(e.target.value)} placeholder="Label (optional)" className="h-7 flex-1 text-xs" />
            <Button type="submit" size="sm" variant="ghost" className="h-7 text-xs">Add</Button>
            <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </form>
      )}
    </Section>
  );
};

register(TLinks, 'react', LinksView);

// ── Comments ──

const CommentsView: View<TComments> = ({ value }) => {
  const actions = useActions(value);
  const [draft, setDraft] = useState('');
  const items = Array.isArray(value.items) ? value.items : [];

  return (
    <Section label={`Comments${items.length ? ` (${items.length})` : ''}`}>
      {items.length > 0 && (
        <div className="mb-2 max-h-48 space-y-2 overflow-y-auto">
          {items.map((c, i) => (
            <div key={i} className="rounded bg-white/[0.03] px-2.5 py-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs font-medium text-sky-400">{c.author}</span>
                <span className="text-[10px] text-muted-foreground">
                  {c.createdAt ? new Date(c.createdAt).toLocaleString() : ''}
                </span>
              </div>
              <p className="mt-0.5 whitespace-pre-wrap text-sm">{c.text}</p>
            </div>
          ))}
        </div>
      )}

      <form
        className="flex gap-1.5"
        onSubmit={e => {
          e.preventDefault();
          if (!draft.trim()) return;
          actions.add({ text: draft });
          setDraft('');
        }}
      >
        <Input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder="Add comment..."
          className="h-7 flex-1 text-xs"
        />
        <Button type="submit" size="sm" variant="ghost" className="h-7 px-2 text-xs">Send</Button>
      </form>
    </Section>
  );
};

register(TComments, 'react', CommentsView);

// ── Time Track ──

function formatDuration(ms: number) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

const TimeTrackView: View<TTimeTrack> = ({ value }) => {
  const actions = useActions(value);
  const entries = Array.isArray(value.entries) ? value.entries : [];
  const running = !!value.running;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  const total = entries.reduce((sum, e) => {
    const end = e.end || Date.now();
    return sum + (end - e.start);
  }, 0);

  return (
    <Section label="Time Tracking">
      <div className="flex items-center gap-3">
        <span className={cn('text-lg font-mono font-medium', running && 'text-emerald-400')}>
          {formatDuration(total)}
        </span>

        {running ? (
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => actions.stop()}>
            Stop
          </Button>
        ) : (
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => actions.start()}>
            Start
          </Button>
        )}
      </div>

      {entries.length > 1 && (
        <div className="mt-2 space-y-0.5 text-[11px] text-muted-foreground">
          {entries.map((e, i) => (
            <div key={i} className="flex justify-between">
              <span>{new Date(e.start).toLocaleTimeString()}</span>
              <span>{e.end ? formatDuration(e.end - e.start) : 'running...'}</span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
};

register(TTimeTrack, 'react', TimeTrackView);

// ── AttachMenu — universal "add component" popover ──

function getAttachedKeys(node: NodeData): Set<string> {
  const keys = new Set<string>();
  for (const k of Object.keys(node)) {
    if (k.startsWith('$')) continue;
    const v = node[k];
    if (v && typeof v === 'object' && '$type' in v) {
      keys.add(k);
    }
  }
  return keys;
}

function AttachDropdown({ items, onSelect, onClose }: {
  items: typeof ATTACHABLE_COMPONENTS;
  onSelect: (c: typeof ATTACHABLE_COMPONENTS[number]) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const keyHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', keyHandler);
    return () => { document.removeEventListener('mousedown', handler); document.removeEventListener('keydown', keyHandler); };
  }, [onClose]);

  const filtered = items.filter(c => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return c.label.toLowerCase().includes(q) || c.description.toLowerCase().includes(q);
  });

  return (
    <div
      ref={ref}
      className="absolute left-0 bottom-full z-50 mb-1 w-64 rounded-md border border-border bg-popover p-2 shadow-lg"
    >
      {items.length > 4 && (
        <Input
          autoFocus
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Filter..."
          className="mb-2 h-7 text-xs"
        />
      )}
      <div className="max-h-48 space-y-0.5 overflow-y-auto">
        {filtered.map(c => (
          <button
            key={c.key}
            className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/50"
            onClick={() => onSelect(c)}
          >
            <span className="mt-0.5 text-sm">{c.icon}</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium">{c.label}</div>
              <div className="truncate text-[11px] text-muted-foreground">{c.description}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

export function AttachMenu({ node }: { node: NodeData }) {
  const [open, setOpen] = useState(false);
  const attached = getAttachedKeys(node);

  const available = ATTACHABLE_COMPONENTS.filter(c => !attached.has(c.key));

  const attach = async (c: typeof ATTACHABLE_COMPONENTS[number]) => {
    try {
      await trpc.patch.mutate({ path: node.$path, ops: [['r', c.key, { $type: c.type, ...c.defaults }]] });
      toast.success(`${c.label} attached`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed');
    }
    setOpen(false);
  };

  const detach = async (key: string) => {
    try {
      await trpc.patch.mutate({ path: node.$path, ops: [['d', key]] });
      toast.success('Component removed');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed');
    }
  };

  const attachedList = ATTACHABLE_COMPONENTS.filter(c => attached.has(c.key));

  if (available.length === 0 && attachedList.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {attachedList.map(c => (
        <span
          key={c.key}
          className="group inline-flex items-center gap-1 rounded-md bg-white/5 px-2 py-0.5 text-xs text-muted-foreground"
        >
          <span>{c.icon}</span>
          <span>{c.label}</span>
          <button
            className="hidden text-[10px] hover:text-destructive group-hover:inline"
            onClick={() => detach(c.key)}
            title={`Remove ${c.label}`}
          >
            ✕
          </button>
        </span>
      ))}

      {available.length > 0 && (
        <div className="relative">
          <button
            className="rounded-md border border-dashed border-zinc-600 px-2 py-0.5 text-xs text-muted-foreground hover:border-zinc-400 hover:text-foreground"
            onClick={() => setOpen(v => !v)}
          >
            + Component
          </button>

          {open && <AttachDropdown items={available} onSelect={attach} onClose={() => setOpen(false)} />}
        </div>
      )}
    </div>
  );
}
