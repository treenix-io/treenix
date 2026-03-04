import { Render, RenderContext } from '#context';
import { useChildren } from '#hooks';
import { trpc } from '#trpc';
import { type ComponentData, type NodeData, register } from '@treenity/core/core';
import { useCallback, useState } from 'react';
import { getComponents, getPlainFields, getSchema } from './node-utils';

/** Fallback for components without their own react handler */
function ComponentFieldsView({ value }: { value: ComponentData }) {
  const s = getSchema(value.$type);
  const fields = s ? Object.entries(s.properties) : [];

  if (fields.length > 0) {
    return (
      <>
        {fields.map(([k, prop]) => {
          const val = (value as any)[k];
          return (
            <div key={k} className="comp-view-row">
              <span className="comp-view-label">{(prop as any).title || k}</span>
              <span className="comp-view-value">
                {val === undefined || val === '' ? '—' : typeof val === 'object' ? JSON.stringify(val) : String(val)}
              </span>
            </div>
          );
        })}
      </>
    );
  }

  const entries = Object.entries(value).filter(([k]) => !k.startsWith('$'));
  if (entries.length === 0) return null;

  return (
    <>
      {entries.map(([k, v]) => (
        <div key={k} className="comp-view-row">
          <span className="comp-view-label">{k}</span>
          <span className="comp-view-value">
            {typeof v === 'string' ? v || '—' : typeof v === 'object' ? JSON.stringify(v) : String(v)}
          </span>
        </div>
      ))}
    </>
  );
}

function GenerateViewButton({ type, sample }: { type: string; sample: NodeData }) {
  const [status, setStatus] = useState<'idle' | 'generating' | 'done' | 'error'>('idle');
  const [error, setError] = useState('');

  const generate = useCallback(async () => {
    setStatus('generating');
    try {
      const clean = Object.fromEntries(
        Object.entries(sample).filter(([k]) => !['$rev', '$acl', '$owner'].includes(k)),
      );
      await trpc.execute.mutate({
        path: '/metatron',
        action: 'task',
        data: { prompt: `Generate a React view for type "${type}". Sample data:\n${JSON.stringify(clean, null, 2)}` },
      });
      setStatus('done');
    } catch (err: any) {
      setError(err.message);
      setStatus('error');
    }
  }, [type, sample]);

  if (status === 'generating') {
    return <div className="text-sm text-blue-400 animate-pulse py-2">Creating task...</div>;
  }
  if (status === 'error') {
    return <div className="text-sm text-red-400 py-2">{error}</div>;
  }
  if (status === 'done') {
    return <div className="text-sm text-green-400 py-2">Task created in /metatron — waiting for AI</div>;
  }

  return (
    <button
      onClick={generate}
      className="text-sm text-blue-400 hover:text-blue-300 border border-blue-400/30 rounded px-3 py-1.5 my-2"
    >
      Generate AI View
    </button>
  );
}

function DefaultNodeView({ value }: { value: NodeData }) {
  const children = useChildren(value.$path);
  const plain = getPlainFields(value);
  const components = getComponents(value);
  const hasInfo = Object.keys(plain).length > 0 || components.length > 0;
  const canGenerate = value.$type.includes('.');

  return (
    <div className="node-default-view">
      {canGenerate && <GenerateViewButton type={value.$type} sample={value} />}

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

/** Dispatch: node → DefaultNodeView, component → ComponentFieldsView */
function DefaultView({ value }: { value: ComponentData }) {
  if ('$path' in value) return <DefaultNodeView value={value as NodeData} />;
  return <ComponentFieldsView value={value} />;
}

register('default', 'react', DefaultView as any);
