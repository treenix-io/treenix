// Default react:layout handler
// If node has a named component 'layout' (any type) — render it
// Otherwise — fall through to react context

import { Render, RenderContext, scopeOnChange, type OnChange } from '#context';
import { type ComponentData, type NodeData, register } from '@treenity/core';
import { useMemo } from 'react';

function DefaultLayout({ value, onChange }: { value: ComponentData; onChange?: (p: OnChange) => void }) {
  const scopedOnChange = useMemo(
    () => onChange ? scopeOnChange(onChange, 'layout') : undefined,
    [onChange],
  )

  if ('$path' in value) {
    const node = value as NodeData;
    const layout = node.layout;
    if (layout && typeof layout === 'object' && '$type' in layout) {
      return <Render value={layout as ComponentData} onChange={scopedOnChange} />;
    }
  }

  return (
    <RenderContext name="react">
      <Render value={value} onChange={onChange} />
    </RenderContext>
  );
}

register('default', 'react:layout', DefaultLayout as any);
