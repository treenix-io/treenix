// Default react:layout handler — delegates to react context
// Types can register custom react:layout handlers to override arrangement

import { Render, RenderContext } from '#context';
import { type ComponentData, register } from '@treenity/core';

function DefaultLayout({ value }: { value: ComponentData }) {
  return (
    <RenderContext name="react">
      <Render value={value} />
    </RenderContext>
  );
}

register('default', 'react:layout', DefaultLayout as any);
