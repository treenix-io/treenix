// Ref node/component view — shows target path, resolve button, inline preview

import { Button } from '#components/ui/button';
import { NodeProvider, Render, RenderContext } from '#context';
import { usePath, useTreeEffects } from '#hooks';
import { type NodeData, register } from '@treenx/core';
import { useState } from 'react';

// ── Node-level view (for ref nodes like /sys/autostart/xxx) ──

function RefNodeView({ value, onSelect }: { value: NodeData; onSelect?: (p: string) => void }) {
  const ref = (value as any).$ref as string | undefined;
  if (!ref) return <div className="text-sm text-muted-foreground">Invalid ref (no $ref)</div>;

  return <RefDisplay target={ref} onSelect={onSelect} />;
}

// ── List item content (chrome provided by observer's RenderChildren) ──

function RefListItem({ value }: { value: NodeData }) {
  const ref = (value as any).$ref as string | undefined;
  const name = value.$path.split('/').at(-1) || value.$path;

  return (
    <>
      <span className="flex h-6 w-6 items-center justify-center rounded bg-secondary text-[12px]">
        &#128279;
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] font-medium text-foreground">{name}</span>
        <span className="truncate text-[11px] text-muted-foreground">{ref ?? 'ref'}</span>
      </div>
    </>
  );
}

// ── Shared display ──

function RefDisplay({ target, onSelect }: { target: string; onSelect?: (p: string) => void }) {
  const effects = useTreeEffects();
  const [resolved, setResolved] = useState(false);
  const { data: targetNode } = usePath(resolved ? target : null);

  return (
    <div className="space-y-3">
      {/* Link row */}
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground text-sm">ref</span>
        <span className="text-sm font-mono text-primary">{target}</span>

        {onSelect && (
          <Button
            variant="outline"
            size="sm"
            className="h-auto px-2 py-0.5 text-xs"
            onClick={() => onSelect(target)}
          >
            Go to
          </Button>
        )}

        <Button
          variant="outline"
          size="sm"
          className="h-auto px-2 py-0.5 text-xs"
          onClick={() => setResolved(!resolved)}
        >
          {resolved ? 'Collapse' : 'Resolve'}
        </Button>
      </div>

      {/* Resolved target */}
      {resolved && (
        <div className="border border-border rounded p-3 bg-muted/30">
          {targetNode ? (
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
                <span className="font-mono">{targetNode.$type}</span>
                <span>{targetNode.$path}</span>
              </div>
              <NodeProvider value={targetNode}><Render value={targetNode} ctx={effects.lane ? { node: targetNode, path: targetNode.$path,
                execute: (action, data) => effects.execute(targetNode.$path, action, data) } : undefined} /></NodeProvider>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">Loading...</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Route-context view: when a /sys/routes/* node is a ref, follow it and
//    render the target as the page content (in plain `react` context). ──

function RefRouteView({ value }: { value: { readonly $ref: string } }) {
  const effects = useTreeEffects();
  const ref = value.$ref;
  const { data: target } = usePath(ref ?? '');
  if (!ref) return null;
  if (!target) return null;
  return (
    <RenderContext name="react">
      <NodeProvider value={target}><Render value={target} ctx={effects.lane ? { node: target, path: target.$path,
        execute: (action, data) => effects.execute(target.$path, action, data) } : undefined} /></NodeProvider>
    </RenderContext>
  );
}

// ── Registration ──

register('ref', 'react', RefNodeView as any);
register('ref', 'react:list', RefListItem as any);
register('ref', 'react:route', RefRouteView);
