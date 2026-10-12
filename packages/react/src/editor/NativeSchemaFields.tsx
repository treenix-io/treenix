import { useState } from 'react';
import type { Component, JsonSchema } from '@treenx/core/kernel/types';
import type { PropertySchema } from '@treenx/core/schema/types';
import { renderField } from '#mods/editor-ui/form-field';
import { useNativeTypeDescription } from '#schema-loader';
import { FieldLabel } from '#mods/editor-ui/FieldLabel';
import { DraftTextarea } from '#mods/editor-ui/DraftTextarea';

/** Tuple items need a JSON widget; homogeneous arrays use the existing item controls. */
function tupleItems(items: JsonSchema | readonly JsonSchema[]): items is readonly JsonSchema[] {
  return Array.isArray(items);
}

/** Select the existing form widgets without changing the kernel's full validation schema. */
export function fieldWidget(schema: JsonSchema): PropertySchema | undefined {
  if (schema.type !== undefined && typeof schema.type !== 'string') return undefined;
  if (schema.anyOf !== undefined || schema.oneOf !== undefined || schema.allOf !== undefined)
    return undefined;

  const values: (string | number)[] = [];
  for (const value of schema.enum ?? []) {
    if (typeof value !== 'string' && typeof value !== 'number') return undefined;
    values.push(value);
  }

  if (schema.type === undefined) return undefined;

  const items =
    schema.items !== undefined && !tupleItems(schema.items) ? fieldWidget(schema.items) : undefined;

  return {
    type: schema.type,
    title: schema.title,
    description: schema.description,
    format: schema.format,
    readOnly: schema.readOnly,
    default: schema.default,
    ...(items === undefined ? {} : { items }),
    ...(schema.enum === undefined ? {} : { enum: values }),
    ...(schema.enumNames === undefined ? {} : { enumNames: [...schema.enumNames] }),
    ...(schema.refType === undefined ? {} : { refType: schema.refType }),
    minimum: schema.minimum,
    maximum: schema.maximum,
    minLength: schema.minLength,
    maxLength: schema.maxLength,
    pattern: schema.pattern,
  };
}

/** Keep arbitrary legal schema values editable when a specialized widget cannot represent them. */
function JsonField({
  name,
  value,
  onChange,
  readOnly,
}: {
  name: string;
  value: unknown;
  onChange: (name: string, value: unknown) => void;
  readOnly?: boolean;
}) {
  const [owned, setOwned] = useState(() => ({
    value,
    text: JSON.stringify(value, null, 2) ?? 'null',
  }));
  let text = owned.text;
  if (owned.value !== value) {
    text = JSON.stringify(value, null, 2) ?? 'null';
    setOwned({ value, text });
  }
  const [error, setError] = useState<string>();

  /** Decode user input before admitting it into the editor draft. */
  function edit(next: string): void {
    try {
      const parsed: unknown = JSON.parse(next);
      setOwned({ value: parsed, text: next });
      onChange(name, parsed);
      setError(undefined);
    } catch (reason) {
      setOwned({ value, text: next });
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <div className="field stack">
      <FieldLabel
        label={name}
        value={value}
        onChange={readOnly ? undefined : (next) => onChange(name, next)}
      />
      {readOnly ? (
        <pre className="text-[11px] font-mono text-foreground/60 whitespace-pre-wrap">{text}</pre>
      ) : (
        <DraftTextarea className="min-h-16 text-xs font-mono" value={text} onChange={edit} />
      )}
      {error !== undefined && <p role="alert">{error}</p>}
    </div>
  );
}

/** Preserve the registered schema while selecting existing supported widgets for each field. */
export function NativeSchemaForm({
  schema,
  value,
  onChange,
  readOnly,
}: {
  schema: JsonSchema;
  value: Readonly<Record<string, unknown>>;
  onChange: (name: string, value: unknown) => void;
  readOnly?: boolean;
}) {
  return (
    <div className="py-0.5 pb-2.5">
      {Object.entries(schema.properties ?? {}).map(([name, schema]) => {
        const widget = fieldWidget(schema);
        return widget === undefined ? (
          <JsonField
            key={name}
            name={name}
            value={value[name]}
            onChange={onChange}
            readOnly={readOnly || schema.readOnly}
          />
        ) : (
          renderField(name, { ...widget, readOnly: readOnly || widget.readOnly }, value, onChange)
        );
      })}
    </div>
  );
}

/** Render actual native descriptor fields through existing widgets and honest JSON fallbacks. */
export function NativeSchemaFields({
  value,
  onChange,
}: {
  value: Component;
  onChange: (name: string, value: unknown) => void;
}) {
  const description = useNativeTypeDescription(value.$type);
  if (description === undefined) return <p>Loading schema…</p>;

  return <NativeSchemaForm schema={description.schema} value={value} onChange={onChange} />;
}
