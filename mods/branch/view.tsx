import { register } from '@treenx/core';
import { useActions, type View } from '@treenx/react';
import { Button } from '@treenx/react/ui/button';
import { useEffect, useState } from 'react';
import { Branch, type DiffEntry } from './types';

const STATUS_STYLE: Record<string, string> = {
  open: 'bg-blue-100 text-blue-800',
  review: 'bg-amber-100 text-amber-800',
  merged: 'bg-green-100 text-green-800',
  conflict: 'bg-red-100 text-red-800',
  abandoned: 'bg-gray-200 text-gray-600',
};

const OP_STYLE: Record<DiffEntry['op'], string> = {
  create: 'text-green-600',
  set: 'text-amber-600',
  remove: 'text-red-600',
  noop: 'text-muted-foreground',
};

const OP_SIGN: Record<DiffEntry['op'], string> = { create: '+', set: '~', remove: '−', noop: '·' };

const BranchView: View<Branch> = ({ value, ctx }) => {
  const actions = useActions(value);
  const [entries, setEntries] = useState<DiffEntry[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    actions.diff()
      // decode at the execute() boundary — Actions<T> returns Promise<unknown>
      .then(r => { if (alive) setEntries((r as { entries: DiffEntry[] }).entries); })
      .catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [actions, value.status]);

  const run = (fn: () => Promise<unknown>) => () => {
    setError('');
    fn().catch(e => setError(e instanceof Error ? e.message : String(e)));
  };

  const canWork = value.status === 'open' || value.status === 'review' || value.status === 'conflict';

  return (
    <div className="max-w-2xl space-y-3 p-4">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold">{value.title || ctx?.path}</h2>
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[value.status] ?? ''}`}>
          {value.status}
        </span>
        <span className="text-xs text-muted-foreground">owner: {value.owner} · base: {value.base}</span>
      </div>

      {error && <div className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {value.conflicts.length > 0 && (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm">
          <div className="mb-1 font-medium text-red-800">Conflicts</div>
          {value.conflicts.map(c => (
            <div key={c.path} className="font-mono text-xs text-red-700">
              {c.path} — expected rev {String(c.expectedRev)}, live is {String(c.actualRev)}
            </div>
          ))}
        </div>
      )}

      <div className="rounded border">
        <div className="border-b px-3 py-1.5 text-xs font-medium text-muted-foreground">
          {entries === null ? 'loading diff…' : `${entries.length} change${entries.length === 1 ? '' : 's'}`}
        </div>
        {entries?.map(e => (
          <div key={e.path} className="flex items-baseline gap-2 px-3 py-1 font-mono text-xs">
            <span className={`w-3 font-bold ${OP_STYLE[e.op]}`}>{OP_SIGN[e.op]}</span>
            <span className={OP_STYLE[e.op]}>{e.path}</span>
            {e.node && typeof e.node.title === 'string' && (
              <span className="truncate text-muted-foreground">{e.node.title}</span>
            )}
          </div>
        ))}
        {entries !== null && entries.length === 0 && (
          <div className="px-3 py-2 text-xs text-muted-foreground">branch is clean</div>
        )}
      </div>

      <div className="flex gap-2">
        {value.status === 'open' && (
          <Button size="sm" variant="outline" onClick={run(() => actions.requestMerge())}>
            Request merge
          </Button>
        )}
        {canWork && (
          <Button size="sm" onClick={run(() => actions.merge())}>Merge</Button>
        )}
        {value.status !== 'merged' && value.status !== 'abandoned' && (
          <Button size="sm" variant="ghost" onClick={run(() => actions.abandon())}>Abandon</Button>
        )}
      </div>
    </div>
  );
};

register(Branch, 'react', BranchView);
