// ComponentSection — renders one component's edit UI (header + fields + actions)
// Used by NodeEditor for both the main type section and named component sections.

import { ConfirmPopover } from '#components/ConfirmPopover';
import { Button } from '#components/ui/button';
import { NodeProvider, Render, RenderContext, type OnChange } from '#context';
import type { ComponentData, NodeData } from '@treenx/core';
import { Trash2 } from 'lucide-react';
import { ActionCardList } from './ActionCards';
import { ErrorBoundary } from '#app/ErrorBoundary';

function EditPanel({ node, value, onChange }: {
  node: NodeData;
  value: ComponentData;
  onChange?: (partial: OnChange) => void;
}) {
  return (
    <NodeProvider value={node}>
      <RenderContext name="react:edit:props">
        <Render value={value} onChange={onChange} />
      </RenderContext>
    </NodeProvider>
  );
}

export type ComponentSectionProps = {
  node: NodeData;
  name: string;
  value: ComponentData;
  onChange?: (partial: OnChange) => void;
  collapsed?: boolean;
  onToggle?: () => void;
  onRemove?: () => void;
  toast: (msg: string) => void;
  onActionComplete?: () => void;
};

export function ComponentSection({
  node,
  name,
  value,
  onChange,
  collapsed,
  onToggle,
  onRemove,
  toast,
  onActionComplete,
}: ComponentSectionProps) {
  const isMain = !name;
  const compType = value.$type;

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
          <EditPanel node={node} value={value} onChange={onChange} />
          <ActionCardList
            path={node.$path}
            componentName={name}
            compType={compType}
            compData={value}
            toast={toast}
            onActionComplete={onActionComplete}
          />
        </ErrorBoundary>
      )}
    </div>
  );
}
