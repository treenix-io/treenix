import { NativeSchemaForm } from '#editor/NativeSchemaFields';
import { useClientRegistry } from '#context/client-registry-context';
import { type ComponentData, isComponent, isRef, register } from '@treenx/core';
import type { View } from '#context';
import { useNativeTypeDescription } from '#schema-loader';
import { Checkbox } from '#components/ui/checkbox';
import { Input } from '#components/ui/input';
import { FieldLabel, RefEditor } from './FieldLabel';
import { renderField, StringArrayField } from './form-field';

/** Keep the existing schema and raw-field forms under the actual native type owner. */
const DefaultEditForm: View<ComponentData> = ({ value, onChange }) => {
  const registry = useClientRegistry();
  const description = useNativeTypeDescription(value.$type);
  if (description === undefined) return null;

  // value may be the node itself — components have their own editor sections.
  const data: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(value)) {
    if (name.startsWith('$') || isComponent(field)) continue;
    data[name] = field;
  }
  const set = (name: string, field: unknown) => onChange?.({ [name]: field });

  if (Object.keys(description.schema.properties ?? {}).length > 0) {
    return (
      <NativeSchemaForm
        schema={description.schema}
        value={data}
        onChange={set}
        readOnly={onChange === undefined}
      />
    );
  }

  if (Object.keys(data).length === 0) {
    return <div className="text-[11px] italic text-muted-foreground py-1.5">no fields</div>;
  }

  return (
    <div className="py-0.5 pb-2.5">
      {Object.entries(data).map(([name, field]) => {
        if (isRef(field) && onChange !== undefined) {
          return (
            <div key={name} className="field">
              <FieldLabel label={name} value={field} onChange={(next) => set(name, next)} />
              <RefEditor value={field} onChange={(next) => set(name, next)} />
            </div>
          );
        }
        if (onChange === undefined)
          return renderField(
            registry,
            name,
            { type: Array.isArray(field) ? 'array' : typeof field, readOnly: true },
            data,
            set,
          );
        if (typeof field === 'object' && !Array.isArray(field))
          return renderField(registry, name, { type: 'object' }, data, set);

        return (
          <div
            key={name}
            className={`field${Array.isArray(field) || (typeof field === 'object' && field !== null) ? ' stack' : ''}`}
          >
            <FieldLabel label={name} value={field} onChange={(next) => set(name, next)} />
            {typeof field === 'boolean' ? (
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={field}
                  onChange={(event) => set(name, event.currentTarget.checked)}
                />
                {field ? 'true' : 'false'}
              </label>
            ) : typeof field === 'number' ? (
              <Input
                type="number"
                className="h-7 text-xs"
                value={String(field)}
                onChange={(event) => set(name, Number(event.target.value))}
              />
            ) : Array.isArray(field) ? (
              <StringArrayField value={field} onChange={(next) => set(name, next)} />
            ) : (
              <Input
                className="h-7 text-xs"
                value={String(field ?? '')}
                onChange={(event) => set(name, event.target.value)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
};

register('default', 'react:edit', DefaultEditForm);
// Inspector props drawer renders under 'react:edit:props' (ComponentSection). Without this exact
// default, resolve strips ':props' and full-page react:edit views (kanban, canvas) leak into the drawer.
register('default', 'react:edit:props', DefaultEditForm);
