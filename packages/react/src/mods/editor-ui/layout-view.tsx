// Default react:layout handler — renders node components + children
// Types can register custom react:layout handlers to override arrangement

import { Render, RenderContext } from '#context';
import { useChildren } from '#hooks';
import { type ComponentData, type NodeData, register } from '@treenity/core/core';
import { getComponents, getPlainFields } from './node-utils';

function DefaultLayout({ value }: { value: ComponentData }) {
  if (!('$path' in value)) return null;
  const node = value as NodeData;
  const children = useChildren(node.$path);
  const plain = getPlainFields(node);
  const components = getComponents(node);
  const hasInfo = Object.keys(plain).length > 0 || components.length > 0;

  return (
    <div className="node-layout">
      <RenderContext name="react">
        {components.map(([name, comp]) => {
          const ctype = (comp as any).$type;
          return (
            <div key={name} className="comp-view-card">
              <div className="comp-view-header">
                {name}
                {name !== ctype && <span className="comp-type">{ctype}</span>}
              </div>
              <Render value={comp as ComponentData} />
            </div>
          );
        })}
      </RenderContext>

      {Object.keys(plain).length > 0 && (
        <div className="node-info-bar">
          {Object.entries(plain).map(([k, v]) => (
            <span key={k} className="node-info-chip data">
              <span className="node-info-chip-label">{k}</span>
              <span className="node-info-chip-val">
                {typeof v === 'string' ? v : JSON.stringify(v)}
              </span>
            </span>
          ))}
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

      {children.length === 0 && !hasInfo && <div className="node-empty">Empty node</div>}
    </div>
  );
}

register('default', 'react:layout', DefaultLayout as any);
