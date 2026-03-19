// ComponentSection — renders one component's edit UI (header + fields + actions)
// Used by NodeEditor for both the main type section and named component sections.

import { ConfirmPopover } from '#components/ConfirmPopover';
import { Button } from '#components/ui/button';
import { NodeProvider, Render, RenderContext } from '#context';
import type { ComponentData, NodeData } from '@treenity/core';
import { Trash2 } from 'lucide-react';
import { ActionCardList } from './ActionCards';
import { ErrorBoundary } from './ErrorBoundary';

function EditPanel({ node, type, data, onData }: {
  node: NodeData;
  type: string;
  data: Record<string, unknown>;
  onData: (d: Record<string, unknown>) => void;
}) {
  return (
    <NodeProvider value={node}>
      <RenderContext name="react:edit">
        <Render
          value={{ $type: type, ...data } as ComponentData}
          onChange={(next: ComponentData) => {
            const d: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(next as Record<string, unknown>)) {
              if (k === '$type' || k === '$path') continue;
              d[k] = v;
            }
            onData(d);
          }}
        />
      </RenderContext>
    </NodeProvider>
  );
}

export type ComponentSectionProps = {
  node: NodeData;
  name: string;
  compType: string;
  data: Record<string, unknown>;
  onData: (d: Record<string, unknown>) => void;
  collapsed?: boolean;
  onToggle?: () => void;
  onRemove?: () => void;
  toast: (msg: string) => void;
  onActionComplete?: () => void;
};

export function ComponentSection({
  node,
  name,
  compType,
  data,
  onData,
  collapsed,
  onToggle,
  onRemove,
  toast,
  onActionComplete,
}: ComponentSectionProps) {
  const isMain = !name;

  return (
    <div className="border-t border-border mt-2 pt-0.5 first:border-t-0 first:mt-0 first:pt-0">
      <div
        className="flex items-center justify-between py-2 pb-1.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider cursor-pointer select-none"
        onClick={onToggle}
      >
        {isMain ? (
          <span>{compType}</span>
        ) : (
          <span className="font-mono text-[12px]">{name}</span>
        )}
        {!isMain && (
          <span className="flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground/50 font-mono">{compType}</span>
            {onRemove && (
              <ConfirmPopover
                title={`Remove "${name}"?`}
                variant="destructive"
                onConfirm={onRemove}
              >
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-muted-foreground/40 hover:text-destructive"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </ConfirmPopover>
            )}
          </span>
        )}
      </div>

      {!collapsed && (
        <ErrorBoundary key={`${node.$path}:${compType}`}>
          <EditPanel node={node} type={compType} data={data} onData={onData} />
          <ActionCardList
            path={node.$path}
            componentName={name}
            compType={compType}
            compData={data}
            toast={toast}
            onActionComplete={onActionComplete}
          />
        </ErrorBoundary>
      )}
    </div>
  );
}
