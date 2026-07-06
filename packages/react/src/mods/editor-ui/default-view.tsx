import './editor-ui.css';
import { HoverTooltip } from '#components/ui/tooltip';
import { Render, type View } from '#context';
import { useChildren } from '#hooks';
import { type ComponentData, isComponent, isRef, register, resolveExact } from '@treenx/core';
import type { PropertySchema, TypeSchema } from '@treenx/core/schema/types';
import { createContext, type ReactNode, useContext, useState } from 'react';
import { type ChildCtx, RenderChildren } from './list-items';
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

  // Schema-strict for plain fields: hide undeclared keys (stale legacy data).
  // Always pass through components ($type) and refs — they are ECS aspects, not type fields.
  // No schema → fall back to permissive rendering so unknown types stay visible.
  const strict = !!schema?.properties;
  for (const [name, raw] of Object.entries(value)) {
    if (name.startsWith('$')) continue;
    if (seen.has(name)) continue;
    if (strict && !isComponent(raw) && !isRef(raw)) continue;
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

const CTX_OPTIONS: { id: ChildCtx; label: string }[] = [
  { id: 'list', label: 'List' },
  { id: 'card', label: 'Card' },
  { id: 'icon', label: 'Icon' },
  { id: 'react', label: 'Full' },
];

/** Children listing for node values — the block e764b74 dropped when node and
 *  component views were unified into TypedRecordView (core-6s1). Separate
 *  component so the hooks stay unconditional: TypedRecordView also renders
 *  components, which have no $path to list. Observer owns chrome + switcher;
 *  items are content-only (see list-items.tsx convention). */
function NodeChildren({ path }: { path: string }) {
  const { data: children } = useChildren(path);
  const [childCtx, setChildCtx] = useState<ChildCtx>('list');

  if (children.length === 0) return null;
  return (
    <div className="mt-3">
      <div className="mb-2 flex gap-3 text-[12px]">
        {CTX_OPTIONS.map((o) => (
          <button
            key={o.id}
            onClick={() => setChildCtx(o.id)}
            className={childCtx === o.id ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}
          >
            {o.label}
          </button>
        ))}
      </div>
      <RenderChildren items={children} ctx={childCtx} />
    </div>
  );
}

export const TypedRecordView: View<ComponentData> = ({ value }) => {
  const depth = useContext(DepthCtx);
  if (depth > MAX_DEPTH) return <span className="text-[--text-3] text-xs">...</span>;

  const schema = getSchema(value.$type);
  const { title, rest, components } = splitRecord(value, schema);
  const nodePath = typeof value.$path === 'string' ? value.$path : null;

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

        {nodePath && <NodeChildren path={nodePath} />}
      </div>
    </DepthCtx.Provider>
  );
};

register('default', 'react', TypedRecordView);
