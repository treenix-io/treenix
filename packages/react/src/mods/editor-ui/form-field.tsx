import { Button } from '#components/ui/button';
import { Input } from '#components/ui/input';
import { DraftTextarea } from '#mods/editor-ui/DraftTextarea';
import { isRef, resolveExact } from '@treenx/core';
import type { PropertySchema } from '@treenx/core/schema/types';
import { createElement, useState } from 'react';
import { FieldLabel, RefEditor } from './FieldLabel';

export function renderField(
  name: string,
  prop: PropertySchema,
  data: Record<string, unknown>,
  set: (field: string, value: unknown) => void,
) {
  const label = prop.title ?? name;
  const placeholder = prop.description;

  // anyOf fields (e.g. string | number unions) — show JSON fallback widget
  if (!prop.type && prop.anyOf) {
    return (
      <div key={name} className="field stack">
        <FieldLabel
          label={label}
          value={data[name]}
          onChange={prop.readOnly ? undefined : (next: unknown) => set(name, next)}
        />
        {prop.readOnly ? (
          <pre className="text-[11px] font-mono text-foreground/60 bg-muted/30 rounded p-1.5 whitespace-pre-wrap">
            {JSON.stringify(data[name], null, 2)}
          </pre>
        ) : (
          <DraftTextarea
            className="min-h-16 text-xs font-mono"
            value={JSON.stringify(data[name], null, 2)}
            onChange={(text) => {
              try {
                set(name, JSON.parse(text));
              } catch {
                /* typing in progress */
              }
            }}
          />
        )}
      </div>
    );
  }

  if (!prop.type) return null;

  const rawValue = data[name];
  const isRefValue = rawValue && typeof rawValue === 'object' && isRef(rawValue);

  // If value is a $ref/$map, show ref editor instead of the normal field handler
  if (isRefValue) {
    const onFieldChange = prop.readOnly ? undefined : (next: unknown) => set(name, next);
    return (
      <div key={name} className="field">
        <FieldLabel label={label} value={rawValue} onChange={onFieldChange} />
        {onFieldChange && (
          <RefEditor value={rawValue as { $ref: string; $map?: string }} onChange={onFieldChange} />
        )}
      </div>
    );
  }

  // Resolve handler: try format first (specific widget), fall back to base type,
  // then to a generic 'string' handler. This keeps unknown formats from masking
  // the underlying structural type.
  const ctx = prop.readOnly ? 'react:compact' : 'react:form';
  const altCtx = prop.readOnly ? 'react' : ctx;
  const tryResolve = (t: string) =>
    prop.readOnly
      ? (resolveExact(t, 'react:compact') ?? resolveExact(t, 'react'))
      : resolveExact(t, ctx);
  const resolvedType =
    (prop.format && tryResolve(prop.format) ? prop.format : null) ??
    (tryResolve(prop.type) ? prop.type : null) ??
    'string';
  const handler = tryResolve(resolvedType) ?? resolveExact('string', altCtx);
  if (!handler)
    return (
      <div key={name} className="text-destructive text-xs">
        No form handler: {prop.format ?? prop.type}
      </div>
    );

  const fieldData: { $type: string; [k: string]: unknown } = {
    $type: resolvedType,
    value: rawValue,
    label,
    placeholder,
  };
  if (prop.items) fieldData.items = prop.items;
  if (prop.enum) fieldData.enum = prop.enum;
  if (prop.enumNames) fieldData.enumNames = prop.enumNames;
  if (prop.refType) fieldData.refType = prop.refType;

  const isComplex = prop.type === 'object' || prop.type === 'array';
  const onFieldChange = prop.readOnly
    ? undefined
    : (next: unknown) => set(name, (next as { value: unknown }).value);

  return (
    <div key={name} className={isComplex ? 'field stack' : 'field'}>
      {(prop.type !== 'boolean' || prop.readOnly) && (
        <FieldLabel
          label={label}
          value={rawValue}
          onChange={prop.readOnly ? undefined : (next: unknown) => set(name, next)}
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
