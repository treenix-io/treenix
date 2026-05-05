// Default react:form handler — renders form from type schema automatically
// Any type without a specific react:form handler falls here via resolve('default', 'react:form')

import { type RenderProps } from '#context';
import { useSchema } from '#schema-loader';
import { register, resolve } from '@treenx/core';
import { createElement } from 'react';

function DefaultSchemaForm({ value, onChange }: RenderProps) {
  // useSchema lazy-fetches /sys/types/{type} and registers the schema.
  // undefined = loading, null = type has no schema.
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
      {Object.entries(properties).map(([name, fieldSchema]) => {
        const rawType = String(fieldSchema.type ?? 'string');
        const rawFormat = fieldSchema.format ? String(fieldSchema.format) : undefined;
        const isReadOnly = !!fieldSchema.readOnly;
        const ctx = isReadOnly ? 'react' : 'react:form';
        // Resolve: format widget → base type → generic string. Unknown format must
        // not mask the underlying structural type.
        const resolvedType =
          (rawFormat && resolve(rawFormat, ctx) ? rawFormat : null) ??
          (resolve(rawType, ctx) ? rawType : null) ??
          'string';
        const handler = resolve(resolvedType, ctx);
        if (!handler) {
          return (
            <div key={name} className="text-xs text-destructive">
              No form handler for type: {rawFormat ?? rawType}
            </div>
          );
        }

        const fieldData: Record<string, unknown> = {
          $type: resolvedType,
          value: (value as any)[name],
          label: String(fieldSchema.title ?? name),
          placeholder: fieldSchema.description ? String(fieldSchema.description) : undefined,
        };
        if (fieldSchema.items) fieldData.items = fieldSchema.items;
        if (fieldSchema.enum) fieldData.enum = fieldSchema.enum;
        if (fieldSchema.enumNames) fieldData.enumNames = fieldSchema.enumNames;

        return (
          <div key={name} className="flex flex-col gap-1">
            {resolvedType !== 'boolean' && (
              <label
                className="text-xs font-medium text-muted-foreground block overflow-hidden text-ellipsis"
                title={fieldData.label as string}
              >
                {fieldData.label as string}
              </label>
            )}
            {createElement(handler as any, {
              value: fieldData,
              onChange: (next: any) => onChange?.({ ...value, [name]: next.value }),
            })}
          </div>
        );
      })}
    </div>
  );
}

register('default', 'react:form', DefaultSchemaForm as any);
