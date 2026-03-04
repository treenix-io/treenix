// Default react:form handler — renders form from type schema automatically
// Any type without a specific react:form handler falls here via resolve('default', 'react:form')

import { type RenderProps } from '#context';
import { register, resolve } from '@treenity/core/core';
import { createElement } from 'react';

function DefaultSchemaForm({ value, onChange }: RenderProps) {
  const schemaHandler = resolve(value.$type, 'schema');
  if (!schemaHandler) {
    return <div className="text-xs text-muted-foreground italic">No schema for {value.$type}</div>;
  }

  const schema = schemaHandler() as {
    title?: string;
    properties?: Record<string, Record<string, unknown>>;
  };
  const properties = schema.properties ?? {};

  if (Object.keys(properties).length === 0) {
    return <div className="text-xs text-muted-foreground italic">No fields defined</div>;
  }

  return (
    <div className="flex flex-col gap-3">
      {Object.entries(properties).map(([name, fieldSchema]) => {
        const fieldType = String(fieldSchema.format ?? fieldSchema.type ?? 'string');
        const isReadOnly = !!fieldSchema.readOnly;
        const handler = resolve(fieldType, isReadOnly ? 'react' : 'react:form');
        if (!handler) {
          return (
            <div key={name} className="text-xs text-destructive">
              No form handler for type: {fieldType}
            </div>
          );
        }

        const fieldData: Record<string, unknown> = {
          $type: fieldType,
          value: (value as any)[name],
          label: String(fieldSchema.label ?? fieldSchema.title ?? name),
          placeholder: fieldSchema.description ? String(fieldSchema.description) : undefined,
        };
        if (fieldSchema.items) fieldData.items = fieldSchema.items;
        if (fieldSchema.enum) fieldData.enum = fieldSchema.enum;

        return (
          <div key={name} className="flex flex-col gap-1">
            {fieldType !== 'boolean' && (
              <label className="text-xs font-medium text-muted-foreground">
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
