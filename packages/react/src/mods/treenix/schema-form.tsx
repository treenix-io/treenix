// Default react:form handler — renders form from type schema automatically
// Any type without a specific react:form handler falls here via resolve('default', 'react:form')

import { type OnChange, type RenderProps } from '#context';
import { fieldWidget, NativeSchemaForm } from '#editor/NativeSchemaFields';
import { useSchema } from '#schema-loader';
import { register } from '@treenx/core';
import { useClientRegistry } from '#context/client-registry-context';
import { createElement } from 'react';

/** Keep the original form layout while its selected native owner supplies schema metadata. */
function DefaultSchemaForm({ value, onChange }: RenderProps) {
  const registry = useClientRegistry();
  const schema = useSchema(value.$type);
  if (schema === undefined) {
    return <div className="text-xs text-muted-foreground italic">Loading schema…</div>;
  }
  if (schema === null) {
    return <div className="text-xs text-muted-foreground italic">No schema for {value.$type}</div>;
  }

  const properties = schema.properties ?? {};

  if (Object.keys(properties).length === 0) {
    return <div className="text-xs text-muted-foreground italic">No fields defined</div>;
  }

  return (
    <div className="flex flex-col gap-3">
      {Object.entries(properties).map(([name, schema]) => {
        const fieldSchema = fieldWidget(schema);
        if (fieldSchema === undefined)
          return (
            <NativeSchemaForm
              key={name}
              schema={{ properties: { [name]: schema } }}
              value={value}
              readOnly={onChange === undefined}
              onChange={(name, field) => onChange?.({ [name]: field })}
            />
          );
        const rawType = String(fieldSchema.type ?? 'string');
        const rawFormat = fieldSchema.format ? String(fieldSchema.format) : undefined;
        const isReadOnly = fieldSchema.readOnly || onChange === undefined;
        const ctx = isReadOnly ? 'react' : 'react:form';
        // Resolve: format widget → base type → generic string. Unknown format must
        // not mask the underlying structural type.
        const resolvedType =
          (rawFormat && registry.resolve(rawFormat, ctx) ? rawFormat : null) ??
          (registry.resolve(rawType, ctx) ? rawType : null) ??
          'string';
        const handler = registry.resolve(resolvedType, ctx)?.handler;
        if (!handler) {
          return (
            <div key={name} className="text-xs text-destructive">
              No form handler for type: {rawFormat ?? rawType}
            </div>
          );
        }

        const fieldData = {
          $type: resolvedType,
          value: value[name],
          label: String(fieldSchema.title ?? name),
          placeholder: fieldSchema.description ? String(fieldSchema.description) : undefined,
          ...(fieldSchema.items === undefined ? {} : { items: fieldSchema.items }),
          ...(fieldSchema.enum === undefined ? {} : { enum: fieldSchema.enum }),
          ...(fieldSchema.enumNames === undefined ? {} : { enumNames: fieldSchema.enumNames }),
        };

        return (
          <div key={name} className="flex flex-col gap-1">
            {resolvedType !== 'boolean' && (
              <label
                className="text-xs font-medium text-muted-foreground block overflow-hidden text-ellipsis"
                title={fieldData.label}
              >
                {fieldData.label}
              </label>
            )}
            {createElement(handler, {
              value: fieldData,
              onChange: isReadOnly
                ? undefined
                : (next: OnChange) => onChange?.({ [name]: next.value }),
            })}
          </div>
        );
      })}
    </div>
  );
}

register('default', 'react:form', DefaultSchemaForm);
