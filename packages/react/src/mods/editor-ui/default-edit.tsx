import { Checkbox } from '#components/ui/checkbox';
import { Input } from '#components/ui/input';
import { useSchema } from '#schema-loader';
import { type ComponentData, isRef, register, resolve, resolveExact } from '@treenity/core';
import type { View } from '#context';
import { createElement } from 'react';
import { FieldLabel, RefEditor } from './FieldLabel';
import { renderField, StringArrayField } from './form-field';

const DefaultEditForm: View<ComponentData> = ({ value, onChange }) => {
  const schema = useSchema(value.$type);
  if (schema === undefined) return null;

  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (!k.startsWith('$')) data[k] = v;
  }

  const set = (field: string, val: unknown) => onChange?.({ [field]: val });

  // Schema-driven form
  if (schema && Object.keys(schema.properties).length > 0) {
    return (
      <div className="py-0.5 pb-2.5">
        {Object.entries(schema.properties).map(([field, prop]) => {
          const p = prop as {
            type: string; title: string; format?: string; description?: string;
            readOnly?: boolean; enum?: string[]; items?: { type?: string; properties?: Record<string, unknown> };
            refType?: string;
          };
          return renderField(field, {
            type: p.format ?? p.type, label: p.title ?? field, placeholder: p.description,
            readOnly: p.readOnly || !onChange, enum: p.enum, items: p.items, refType: p.refType,
          }, data, set);
        })}
      </div>
    );
  }

  // Fallback: raw field rendering
  if (Object.keys(data).length > 0) {
    return (
      <div className="py-0.5 pb-2.5">
        {Object.entries(data).map(([k, v]) => {
          const onCh = (next: unknown) => set(k, next);
          if (v && typeof v === 'object' && isRef(v)) {
            return (
              <div key={k} className="field">
                <FieldLabel label={k} value={v} onChange={onCh} />
                <RefEditor value={v as { $ref: string; $map?: string }} onChange={onCh} />
              </div>
            );
          }
          return (
            <div key={k} className={`field${Array.isArray(v) || (typeof v === 'object' && v !== null) ? ' stack' : ''}`}>
              <FieldLabel label={k} value={v} onChange={onCh} />
              {typeof v === 'boolean' ? (
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox checked={!!data[k]}
                    onChange={(e) => set(k, (e.target as HTMLInputElement).checked)} />
                  {data[k] ? 'true' : 'false'}
                </label>
              ) : typeof v === 'number' ? (
                <Input type="number" className="h-7 text-xs" value={String(data[k] ?? 0)}
                  onChange={(e) => set(k, Number(e.target.value))} />
              ) : Array.isArray(v) ? (
                <StringArrayField value={data[k] as unknown[]}
                  onChange={(next) => set(k, next)} />
              ) : typeof v === 'object' ? (
                (() => {
                  const h = resolve('object', 'react:form');
                  return h
                    ? createElement(h as any, {
                        value: { $type: 'object', value: data[k] },
                        onChange: (next: { value: unknown }) => set(k, next.value),
                      })
                    : <pre className="text-[11px] font-mono text-foreground/60">{JSON.stringify(data[k], null, 2)}</pre>;
                })()
              ) : (
                <Input className="h-7 text-xs" value={String(data[k] ?? '')}
                  onChange={(e) => set(k, e.target.value)} />
              )}
            </div>
          );
        })}
      </div>
    );
  }

  // Empty
  return (
    <pre className="text-[11px] font-mono text-foreground/60 bg-muted/30 rounded p-2 whitespace-pre-wrap">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
};

register('default', 'react:edit', DefaultEditForm);
register('default', 'react:edit:props', DefaultEditForm);
