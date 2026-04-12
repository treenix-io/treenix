import { Render, RenderContext } from '#context';
import { useChildren } from '#hooks';
import { type NodeData } from '@treenity/core';

const STATUS_COLORS: Record<string, [string, string]> = {
  draft: ['var(--accent-subtle, #1a2a3a)', 'var(--accent)'],
  published: ['#1a2e1a', '#4c8'],
  archived: ['#2e2a1a', '#ca4'],
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
        <div
          style={{
            padding: 16,
            background: 'var(--surface)',
            borderRadius: 'var(--radius)',
            marginBottom: 12,
          }}
        >
          {meta?.title && <div style={{ fontSize: 18, fontWeight: 600 }}>{meta.title}</div>}
          {meta?.description && (
            <div style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 4 }}>
              {meta.description}
            </div>
          )}
          {(status || counter) && (
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              {status?.value &&
                (() => {
                  const [bg, fg] = STATUS_COLORS[status.value] ?? STATUS_COLORS.draft;
                  return (
                    <span
                      style={{
                        padding: '2px 10px',
                        borderRadius: 12,
                        fontSize: 11,
                        fontWeight: 600,
                        background: bg,
                        color: fg,
                      }}
                    >
                      {status.value}
                    </span>
                  );
                })()}
              {counter != null && (
                <span
                  style={{
                    padding: '2px 10px',
                    borderRadius: 12,
                    fontSize: 11,
                    fontWeight: 600,
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    color: 'var(--text-2)',
                  }}
                >
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
