import './editor-ui.css';
import { Render, RenderContext } from '#context';
import { useChildren } from '#hooks';
import { type ComponentData, type NodeData, register } from '@treenity/core';
import { EmptyNodePlaceholder } from './empty-placeholder';
import { renderField } from './form-field';
import { getComponents, getPlainFields, getSchema } from './node-utils';

const noop = () => {};

/** Fallback for components without their own react handler */
function ComponentFieldsView({ value }: { value: ComponentData }) {
  const schema = getSchema(value.$type);
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (!k.startsWith('$')) data[k] = v;
  }

  if (schema && Object.keys(schema.properties).length > 0) {
    const titleEntry = Object.entries(schema.properties).find(([k]) => TITLE_KEYS.has(k));
    const descEntry = Object.entries(schema.properties).find(([k]) => DESC_KEYS.has(k));

    return (
      <>
        {titleEntry && data[titleEntry[0]] && (
          <div className="text-base font-medium text-[--text] mb-1">{String(data[titleEntry[0]])}</div>
        )}
        {descEntry && data[descEntry[0]] && (
          <p className="text-sm text-[--text-2] mb-3 leading-relaxed whitespace-pre-wrap">{String(data[descEntry[0]])}</p>
        )}
        {Object.entries(schema.properties)
          .filter(([k]) => k !== titleEntry?.[0] && k !== descEntry?.[0])
          .map(([k, prop]) => {
            const p = prop as { type: string; title: string; format?: string; description?: string; enum?: string[]; items?: { type?: string; properties?: Record<string, unknown> }; refType?: string };
            return renderField(k, {
              type: p.format ?? p.type, label: p.title ?? k,
              readOnly: true, enum: p.enum, items: p.items, refType: p.refType,
            }, data, noop);
          })}
      </>
    );
  }

  const entries = Object.entries(data);
  if (entries.length === 0) return null;

  const titleKey = entries.find(([k]) => TITLE_KEYS.has(k));
  const descKey = entries.find(([k]) => DESC_KEYS.has(k));
  const meta = entries.filter(([k]) => k !== titleKey?.[0] && k !== descKey?.[0]);

  return (
    <>
      {titleKey && titleKey[1] && <div className="text-base font-medium text-[--text] mb-1">{String(titleKey[1])}</div>}
      {descKey && descKey[1] && <p className="text-sm text-[--text-2] mb-3 leading-relaxed whitespace-pre-wrap">{String(descKey[1])}</p>}
      {meta.length > 0 && (
        <div className="dv-meta">
          {meta.map(([k, v]) => (
            <div key={k} className="dv-meta-row">
              <span className="dv-meta-label">{k}</span>
              <FieldValue value={v} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function FieldValue({ value }: { value: unknown }) {
  if (value === undefined || value === null || value === '') return <span className="text-[--text-3]">—</span>;
  if (typeof value === 'boolean') return <span className={value ? 'text-green-400' : 'text-[--text-3]'}>{value ? 'Yes' : 'No'}</span>;
  if (typeof value === 'number') return <span className="tabular-nums">{value}</span>;
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
      return <span className="tabular-nums text-[--text-2]">{value}</span>;
    }
    return <span>{value}</span>;
  }
  return <span className="font-mono text-xs text-[--text-2]">{JSON.stringify(value)}</span>;
}

const TITLE_KEYS = new Set(['title', 'name', 'label']);
const DESC_KEYS = new Set(['description', 'desc', 'summary', 'text', 'body', 'content']);

/** Reusable plain-fields renderer: promotes title/desc, renders rest as key-value rows */
export function PlainFieldsView({ plain, typeName }: { plain: Record<string, unknown>; typeName: string }) {
  const schema = getSchema(typeName);
  const keys = Object.keys(plain);
  if (keys.length === 0) return null;

  const titleKey = keys.find((k) => TITLE_KEYS.has(k));
  const descKey = keys.find((k) => DESC_KEYS.has(k));
  const title = titleKey ? String(plain[titleKey] ?? '') : '';
  const desc = descKey ? String(plain[descKey] ?? '') : '';
  const metaKeys = keys.filter((k) => k !== titleKey && k !== descKey);

  return (
    <>
      {title && <h2 className="text-lg font-semibold text-[--text] mb-1">{title}</h2>}
      {desc && <p className="text-sm text-[--text-2] mb-4 leading-relaxed whitespace-pre-wrap">{desc}</p>}

      {metaKeys.length > 0 && schema && Object.keys(schema.properties).length > 0 && (
        <div className="py-0.5 pb-2.5">
          {metaKeys.map((k) => {
            const prop = schema.properties[k];
            if (!prop) return (
              <div key={k} className="dv-meta-row">
                <span className="dv-meta-label">{k}</span>
                <FieldValue value={plain[k]} />
              </div>
            );
            const p = prop as { type: string; title: string; format?: string; description?: string; enum?: string[]; items?: { type?: string; properties?: Record<string, unknown> }; refType?: string };
            return renderField(k, {
              type: p.format ?? p.type, label: p.title ?? k,
              readOnly: true, enum: p.enum, items: p.items, refType: p.refType,
            }, plain, noop);
          })}
        </div>
      )}

      {metaKeys.length > 0 && (!schema || Object.keys(schema.properties).length === 0) && (
        <div className="dv-meta">
          {metaKeys.map((k) => (
            <div key={k} className="dv-meta-row">
              <span className="dv-meta-label">{k}</span>
              <FieldValue value={plain[k]} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function DefaultNodeView({ value }: { value: NodeData }) {
  const children = useChildren(value.$path);
  const plain = getPlainFields(value);
  const components = getComponents(value);
  const hasInfo = Object.keys(plain).length > 0 || components.length > 0;

  return (
    <div className="node-default-view">
      <PlainFieldsView plain={plain} typeName={value.$type} />

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

      {children.length > 0 && (
        <RenderContext name="react:list">
          <div className="children-grid">
            {children.map((child) => (
              <Render key={child.$path} value={child} />
            ))}
          </div>
        </RenderContext>
      )}

      {children.length === 0 && !hasInfo && <EmptyNodePlaceholder value={value} />}
    </div>
  );
}

/** Dispatch: node → DefaultNodeView, component → ComponentFieldsView */
function DefaultView({ value }: { value: ComponentData }) {
  if ('$path' in value) return <DefaultNodeView value={value as NodeData} />;
  return <ComponentFieldsView value={value} />;
}

register('default', 'react', DefaultView as any);
