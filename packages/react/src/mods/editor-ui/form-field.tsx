import { Button } from '#components/ui/button';
import { Input } from '#components/ui/input';
import { DraftTextarea } from '#mods/editor-ui/DraftTextarea';
import { isRef, resolveExact } from '@treenity/core';
import { createElement, useState } from 'react';
import { FieldLabel, RefEditor } from './FieldLabel';

export function renderField(
  name: string,
  fieldSchema: {
    type: string;
    label: string;
    placeholder?: string;
    readOnly?: boolean;
    enum?: string[];
    items?: { type?: string; properties?: Record<string, unknown> };
    refType?: string;
  },
  data: Record<string, unknown>,
  setData: (fn: (prev: Record<string, unknown>) => Record<string, unknown>) => void,
) {
  if (!fieldSchema.type) return null;

  const rawValue = data[name];
  const isRefValue = rawValue && typeof rawValue === 'object' && isRef(rawValue);

  // If value is a $ref/$map, show ref editor instead of the normal field handler
  if (isRefValue) {
    const onFieldChange = fieldSchema.readOnly
      ? undefined
      : (next: unknown) => setData((prev) => ({ ...prev, [name]: next }));
    return (
      <div key={name} className="field">
        <FieldLabel label={fieldSchema.label} value={rawValue} onChange={onFieldChange} />
        {onFieldChange && (
          <RefEditor value={rawValue as { $ref: string; $map?: string }} onChange={onFieldChange} />
        )}
      </div>
    );
  }

  const ctx = fieldSchema.readOnly ? 'react' : 'react:form';
  const handler = resolveExact(fieldSchema.type, ctx) ?? resolveExact('string', ctx);
  if (!handler)
    return (
      <div key={name} className="text-destructive text-xs">
        No form handler: {fieldSchema.type}
      </div>
    );

  const fieldData: { $type: string; [k: string]: unknown } = {
    $type: fieldSchema.type,
    value: rawValue,
    label: fieldSchema.label,
    placeholder: fieldSchema.placeholder,
  };
  if (fieldSchema.items) fieldData.items = fieldSchema.items;
  if (fieldSchema.enum) fieldData.enum = fieldSchema.enum;
  if (fieldSchema.refType) fieldData.refType = fieldSchema.refType;

  const isComplex = fieldSchema.type === 'object' || fieldSchema.type === 'array';
  const onFieldChange = fieldSchema.readOnly
    ? undefined
    : (next: unknown) => setData((prev) => ({ ...prev, [name]: (next as { value: unknown }).value }));

  return (
    <div key={name} className={isComplex ? 'field stack' : 'field'}>
      {fieldSchema.type !== 'boolean' && (
        <FieldLabel
          label={fieldSchema.label}
          value={rawValue}
          onChange={fieldSchema.readOnly ? undefined : (next: unknown) => setData((prev) => ({ ...prev, [name]: next }))}
        />
      )}
      {createElement(handler as any, {
        value: fieldData,
        onChange: onFieldChange,
      })}
    </div>
  );
}

export function StringArrayField({
  value,
  onChange,
}: {
  value: unknown[];
  onChange: (next: unknown[]) => void;
}) {
  const [input, setInput] = useState('');
  const isStrings = value.every((v) => typeof v === 'string');

  if (!isStrings) {
    return (
      <DraftTextarea
        className="min-h-16 text-xs font-mono"
        value={JSON.stringify(value, null, 2)}
        onChange={(text) => {
          try {
            onChange(JSON.parse(text));
          } catch {
            /* typing */
          }
        }}
      />
    );
  }

  const tags = value as string[];
  return (
    <div className="flex-1 space-y-1">
      <div className="flex flex-wrap gap-1">
        {tags.map((tag, i) => (
          <span
            key={i}
            className="inline-flex items-center gap-0.5 text-[11px] font-mono bg-muted text-foreground/70 px-1.5 py-0.5 rounded"
          >
            {tag}
            <Button
              variant="ghost"
              size="icon"
              type="button"
              className="h-5 w-5 p-0 ml-0.5 text-muted-foreground/40 hover:text-foreground leading-none"
              onClick={() => onChange(tags.filter((_, j) => j !== i))}
            >
              x
            </Button>
          </span>
        ))}
      </div>
      <Input
        className="h-7 text-xs w-full"
        placeholder="Add item..."
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          const t = input.trim();
          if (t && !tags.includes(t)) onChange([...tags, t]);
          setInput('');
        }}
      />
    </div>
  );
}
