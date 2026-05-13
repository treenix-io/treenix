import { useChildren } from '#hooks';
import { register, type NodeData } from '@treenx/core';
import { useState } from 'react';
import { RenderChildren, type ChildCtx } from './list-items';

const STATUS_PILL: Record<string, string> = {
  draft: 'border-yellow-300/25 bg-yellow-300/10 text-yellow-300',
  published: 'border-primary/25 bg-primary/10 text-primary',
  archived: 'border-border/20 bg-muted/10 text-muted-foreground',
};

const CTX_OPTIONS: { id: ChildCtx; label: string }[] = [
  { id: 'list', label: 'List' },
  { id: 'card', label: 'Card' },
  { id: 'icon', label: 'Icon' },
  { id: 'react', label: 'Full' },
];

function FolderView({ value }: { value: NodeData }) {
  const { data: children } = useChildren(value.$path);
  const [childCtx, setChildCtx] = useState<ChildCtx>('list');
  const meta = value.metadata as
    | { $type: string; title?: string; description?: string }
    | undefined;
  const status = value.status as { $type: string; value?: string } | undefined;
  const counter = value.counter as { $type: string; count?: number } | undefined;

  return (
    <div className="node-default-view">
      {children.length > 0 && (
        <div className="mb-3 flex gap-3 text-[12px]">
          {CTX_OPTIONS.map((o) => (
            <button
              key={o.id}
              onClick={() => setChildCtx(o.id)}
              className={
                childCtx === o.id
                  ? 'text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
      {(meta || status || counter) && (
        <div className="mb-3 rounded-lg border border-border bg-card p-4">
          {meta?.title && <div className="text-[18px] font-semibold text-foreground">{meta.title}</div>}
          {meta?.description && (
            <div className="mt-1 text-[13px] text-muted-foreground">
              {meta.description}
            </div>
          )}
          {(status || counter) && (
            <div className="mt-2 flex gap-2">
              {status?.value && (
                <span
                  className={`rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] ${STATUS_PILL[status.value] ?? STATUS_PILL.draft}`}
                >
                  {status.value}
                </span>
              )}
              {counter != null && (
                <span className="rounded-full border border-border bg-secondary px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                  count: {counter.count ?? 0}
                </span>
              )}
            </div>
          )}
        </div>
      )}
      <RenderChildren items={children} ctx={childCtx} />
      {children.length === 0 && !meta && !status && !counter && (
        <div className="node-empty">Empty folder</div>
      )}
    </div>
  );
}

register('dir', 'react', FolderView);
