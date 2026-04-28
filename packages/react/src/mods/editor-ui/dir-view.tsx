import { Render, RenderContext } from '#context';
import { useChildren } from '#hooks';
import { type NodeData } from '@treenx/core';

const STATUS_PILL: Record<string, string> = {
  draft: 'border-yellow-300/25 bg-yellow-300/10 text-yellow-300',
  published: 'border-primary/25 bg-primary/10 text-primary',
  archived: 'border-zinc-400/20 bg-zinc-400/10 text-zinc-400',
};

function FolderView({ value }: { value: NodeData }) {
  const { data: children } = useChildren(value.$path);
  const meta = value.metadata as
    | { $type: string; title?: string; description?: string }
    | undefined;
  const status = value.status as { $type: string; value?: string } | undefined;
  const counter = value.counter as { $type: string; count?: number } | undefined;

  return (
    <div className="node-default-view">
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
      {children.length > 0 && (
        <RenderContext name="react:list">
          <div className="children-grid">
            {children.map((child) => (
              <Render key={child.$path} value={child} />
            ))}
          </div>
        </RenderContext>
      )}
      {children.length === 0 && !meta && !status && !counter && (
        <div className="node-empty">Empty folder</div>
      )}
    </div>
  );
}

// register('dir', 'react', FolderView as any);
