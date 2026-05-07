import './editor-ui.css';
import { HoverTooltip } from '#components/ui/tooltip';
import { Render, type View } from '#context';
import { type ComponentData, isComponent, isRef, register, resolveExact } from '@treenx/core';
import type { PropertySchema, TypeSchema } from '@treenx/core/schema/types';
import { createContext, type ReactNode, useContext } from 'react';
import { getSchema } from './node-utils';

const TITLE_KEYS = new Set(['title', 'name', 'label']);
const MAX_DEPTH = 8;
const DepthCtx = createContext(0);

type PlainField = { name: string; prop?: PropertySchema; value: unknown };
type SplitResult = {
  title?: PlainField;
  rest: PlainField[];
  components: { name: string; value: ComponentData }[];
};

export function inferType(v: unknown): string {
  if (Array.isArray(v)) return 'array';
  if (v == null) return 'string';
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return t;
  return 'object';
}

export function resolveDisplayType(prop: PropertySchema | undefined, value: unknown): string {
  const tryResolve = (t?: string) => (t && resolveExact(t, 'react') ? t : null);
  return tryResolve(prop?.format) ?? tryResolve(prop?.type) ?? inferType(value);
}

/** Classify every non-$ key into ref/component/plain, applying schema order first. */
export function splitRecord(value: ComponentData, schema: TypeSchema | null): SplitResult {
  const components: SplitResult['components'] = [];
  const plain: PlainField[] = [];
  const seen = new Set<string>();

  const consider = (name: string, prop: PropertySchema | undefined, raw: unknown) => {
    if (seen.has(name)) return;
    seen.add(name);

    if (isRef(raw)) {
      plain.push({ name, prop, value: raw });
      return;
    }

    if (isComponent(raw)) {
      components.push({ name, value: raw });
      return;
    }

    plain.push({ name, prop, value: raw });
  };

  if (schema?.properties) {
    for (const [name, prop] of Object.entries(schema.properties)) {
      if (name.startsWith('$')) continue;
      if (!(name in value)) continue;
      consider(name, prop, value[name]);
    }
  }

  for (const [name, raw] of Object.entries(value)) {
    if (name.startsWith('$')) continue;
    consider(name, undefined, raw);
  }

  const title = plain.find((field) => TITLE_KEYS.has(field.name));
  const rest = plain.filter((field) => field !== title);
  return { title, rest, components };
}

function FieldRow({ label, tooltip, children }: { label: string; tooltip?: string; children: ReactNode }) {
  return (
    <div className="dv-meta-row">
      <HoverTooltip text={tooltip || label}>
        <span className="dv-meta-label">{label}</span>
      </HoverTooltip>
      {children}
    </div>
  );
}

function PlainFieldRender({ field }: { field: PlainField }) {
  const { name, prop, value } = field;
  const label = name;
  const tooltip = [prop?.title, prop?.description].filter(Boolean).join(' — ') || undefined;

  if (isRef(value)) {
    const refValue = { ...value, $type: value.$type ?? 'ref' };
    return (
      <FieldRow label={label} tooltip={tooltip}>
        <Render value={refValue} />
      </FieldRow>
    );
  }

  const $type = resolveDisplayType(prop, value);
  const fieldData: ComponentData = { $type, value, label };
  if (tooltip) fieldData.tooltip = tooltip;
  if (prop?.description) fieldData.placeholder = prop.description;
  if (prop?.enum) fieldData.enum = prop.enum;
  if (prop?.enumNames) fieldData.enumNames = prop.enumNames;
  if (prop?.items) fieldData.items = prop.items;

  return (
    <FieldRow label={label} tooltip={tooltip}>
      <Render value={fieldData} />
    </FieldRow>
  );
}

function ComponentCard({ name, value }: { name: string; value: ComponentData }) {
  const ctype = value.$type;
  return (
    <div className="comp-view-card">
      <div className="comp-view-header">
        {name}
        {name !== ctype && <span className="comp-type">{ctype}</span>}
      </div>
      <Render value={value} />
    </div>
  );
}

export const TypedRecordView: View<ComponentData> = ({ value }) => {
  const depth = useContext(DepthCtx);
  if (depth > MAX_DEPTH) return <span className="text-[--text-3] text-xs">...</span>;

  const schema = getSchema(value.$type);
  const { title, rest, components } = splitRecord(value, schema);

  return (
    <DepthCtx.Provider value={depth + 1}>
      <div className="node-default-view">
        {title && title.value != null && title.value !== '' && (
          <h2 className="text-lg font-semibold text-[--text] mb-1">{String(title.value)}</h2>
        )}

        {rest.length > 0 && (
          <div className="dv-meta">
            {rest.map((field) => (
              <PlainFieldRender key={field.name} field={field} />
            ))}
          </div>
        )}

        {components.map(({ name, value: comp }) => (
          <ComponentCard key={name} name={name} value={comp} />
        ))}
      </div>
    </DepthCtx.Provider>
  );
};

register('default', 'react', TypedRecordView);
