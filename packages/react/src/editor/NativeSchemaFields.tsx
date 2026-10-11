import { useState } from 'react';
import type { Component, JsonSchema } from '@treenx/core/kernel/types';
import type { PropertySchema } from '@treenx/core/schema/types';
import { JsonEditor } from '#mods/editor-ui/JsonEditor';
import { renderField } from '#mods/editor-ui/form-field';
import { useNativeTypeDescription } from '#schema-loader';

/** Select supported scalar widgets without changing the full registered schema. */
function scalarWidget(schema: JsonSchema): PropertySchema | undefined {
  if (schema.type !== undefined && typeof schema.type !== 'string') return undefined;
  if (schema.properties !== undefined || schema.items !== undefined || schema.anyOf !== undefined
    || schema.oneOf !== undefined || schema.allOf !== undefined) return undefined;

  const values: (string | number)[] = [];
  for (const value of schema.enum ?? []) {
    if (typeof value !== 'string' && typeof value !== 'number') return undefined;
    values.push(value);
  }

  if (schema.type === undefined) return undefined;

  return { type: schema.type, title: schema.title, description: schema.description,
    format: schema.format, readOnly: schema.readOnly, default: schema.default,
    ...(schema.enum === undefined ? {} : { enum: values }),
    minimum: schema.minimum, maximum: schema.maximum, minLength: schema.minLength,
    maxLength: schema.maxLength, pattern: schema.pattern };
}

/** Keep arbitrary legal schema values editable when a specialized widget cannot represent them. */
function JsonField({ name, value, onChange }: {
  name: string; value: unknown; onChange: (name: string, value: unknown) => void;
}) {
  const [owned, setOwned] = useState(() => ({ value, text: JSON.stringify(value, null, 2) ?? 'null' }));
  let text = owned.text;
  if (owned.value !== value) {
    text = JSON.stringify(value, null, 2) ?? 'null';
    setOwned({ value, text });
  }
  const [error, setError] = useState<string>();

  /** Decode user input before admitting it into the editor draft. */
  function edit(next: string): void {
    try { const parsed: unknown = JSON.parse(next); setOwned({ value: parsed, text: next }); onChange(name, parsed); setError(undefined); }
    catch (reason) { setOwned({ value, text: next }); setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  return <div><label>{name}</label><JsonEditor value={text} onChange={edit} />
    {error !== undefined && <p role="alert">{error}</p>}</div>;
}

/** Preserve the registered schema while selecting existing supported widgets for each field. */
export function NativeSchemaForm({ schema, value, onChange }: {
  schema: JsonSchema; value: Readonly<Record<string, unknown>>; onChange: (name: string, value: unknown) => void;
}) {
  return <div className="flex flex-col gap-3">{Object.entries(schema.properties ?? {}).map(([name, schema]) => {
    const widget = scalarWidget(schema);
    return widget === undefined
      ? <JsonField key={name} name={name} value={value[name]} onChange={onChange} />
      : <div key={name}>{renderField(name, widget, value, onChange)}</div>;
  })}</div>;
}

/** Render actual native descriptor fields through existing widgets and honest JSON fallbacks. */
export function NativeSchemaFields({ value, onChange }: {
  value: Component; onChange: (name: string, value: unknown) => void;
}) {
  const description = useNativeTypeDescription(value.$type);
  if (description === undefined) return <p>Loading schema…</p>;

  return <NativeSchemaForm schema={description.schema} value={value} onChange={onChange} />;
}
