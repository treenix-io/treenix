// react:form handlers — editable fields for inspector panel
// react view handlers — readOnly display for same types
// Covers: string, text, textarea, number, integer, boolean, array, object, image, uri, url, select, timestamp, path
import { Button } from '#components/ui/button';
import { Input } from '#components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '#components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#components/ui/select';
import { Switch } from '#components/ui/switch';
import { Textarea } from '#components/ui/textarea';
import { DraftTextarea } from '#mods/editor-ui/DraftTextarea';
import { useSchema } from '#schema-loader';
import * as cache from '#tree/cache';
import { tree as clientStore } from '#tree/client';
import { register, resolve as resolveHandler } from '@treenx/core';
import dayjs from 'dayjs';
import { X } from 'lucide-react';
import { createElement, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

type FP = {
  value: {
    $type: string;
    value: unknown;
    label?: string;
    tooltip?: string;
    placeholder?: string;
    enum?: (string | number)[];
    enumNames?: string[];
    items?: { type?: string };
    refType?: string; // component type — field can hold ref or embedded value of this type
  };
  onChange?: (next: any) => void;
};

// ── View handlers (react context) — readOnly display ──

function EmptyValue() {
  return <span className="text-[--text-3]">—</span>;
}

function isEmpty(v: unknown): boolean {
  return v == null || v === '';
}

function StringView({ value }: FP) {
  if (isEmpty(value.value)) return <EmptyValue />;
  return <span className="text-xs text-foreground/70">{String(value.value ?? '')}</span>;
}

function NumberView({ value }: FP) {
  if (isEmpty(value.value)) return <EmptyValue />;
  return <span className="text-xs font-mono text-foreground/70">{String(value.value ?? 0)}</span>;
}

function BooleanView({ value }: FP) {
  if (isEmpty(value.value)) return <EmptyValue />;
  return <span className="text-xs text-foreground/70">{value.value ? 'true' : 'false'}</span>;
}

function ImageView({ value }: FP) {
  const src = typeof value.value === 'string' ? value.value : '';
  return src ? <img src={src} className="max-w-full max-h-[120px] rounded object-contain" /> : null;
}

function UriView({ value }: FP) {
  if (isEmpty(value.value)) return <EmptyValue />;
  const url = String(value.value ?? '');
  return url ? (
    <a
      href={url}
      target="_blank"
      rel="noopener"
      className="text-xs text-primary hover:underline truncate block"
    >
      {url}
    </a>
  ) : (
    <EmptyValue />
  );
}

function TimestampView({ value }: FP) {
  if (isEmpty(value.value)) return <EmptyValue />;
  const ts = Number(value.value ?? 0);
  const formatted = ts ? dayjs(ts > 1e12 ? ts : ts * 1000).format('YYYY-MM-DD HH:mm:ss') : '—';
  return <span className="text-xs font-mono text-foreground/70">{formatted}</span>;
}

function ArrayView({ value }: FP) {
  const arr = Array.isArray(value.value) ? (value.value as unknown[]) : [];
  if (arr.length === 0) return <span className="text-xs text-muted-foreground">[]</span>;
  if (arr.every((v) => typeof v === 'string')) {
    return (
      <div className="flex flex-wrap gap-1">
        {(arr as string[]).map((tag, i) => (
          <span
            key={i}
            className="text-[11px] font-mono bg-muted text-foreground/70 px-1.5 py-0.5 rounded"
          >
            {tag}
          </span>
        ))}
      </div>
    );
  }
  return (
    <pre className="text-[11px] font-mono text-foreground/70 bg-muted rounded p-2 overflow-auto max-h-[200px]">
      {JSON.stringify(arr, null, 2)}
    </pre>
  );
}

function ObjectView({ value }: FP) {
  const obj = (
    typeof value.value === 'object' && value.value !== null ? value.value : {}
  ) as Record<string, unknown>;
  const entries = Object.entries(obj);
  if (entries.length === 0) return <span className="text-xs text-muted-foreground">{'{}'}</span>;
  return (
    <div className="space-y-0.5">
      {entries.map(([k, v]) => (
        <div key={k} className="flex gap-2 text-[11px]">
          <span className="font-mono text-muted-foreground shrink-0">{k}:</span>
          <span className="font-mono text-foreground/70 truncate">
            {typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Form handlers (react:form context) — editable ──

// Shared enum dropdown: value is the raw enum value, label is enumNames[i] when provided.
// Used by both String and Number form handlers. String select uses stringified values
// for the radix Select primitive; `toValue` converts back when emitting.
function EnumSelect({
  value,
  onChange,
  toValue,
}: {
  value: FP['value'];
  onChange: FP['onChange'];
  toValue: (s: string) => unknown;
}) {
  const options = value.enum ?? [];
  const names = value.enumNames;
  return (
    <Select
      value={String(value.value ?? '')}
      onValueChange={(v) => onChange?.({ ...value, value: toValue(v) })}
    >
      <SelectTrigger size="xs" className="font-mono">
        <SelectValue placeholder="—" />
      </SelectTrigger>
      <SelectContent size="xs">
        {options.map((v, i) => {
          const label = names?.[i];
          return (
            <SelectItem key={String(v)} value={String(v)}>
              {label ? (
                <span>
                  {label} <span className="text-muted-foreground/60">({String(v)})</span>
                </span>
              ) : (
                String(v)
              )}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

function StringForm({ value, onChange }: FP) {
  if (value.enum && value.enum.length > 0)
    return <EnumSelect value={value} onChange={onChange} toValue={(s) => s} />;

  return (
    <Input
      className="h-7 text-xs"
      value={String(value.value ?? '')}
      placeholder={value.placeholder}
      onChange={(e) => onChange?.({ ...value, value: e.target.value })}
    />
  );
}

function TextForm({ value, onChange }: FP) {
  return (
    <Textarea
      className="text-xs md:text-xs"
      value={String(value.value ?? '')}
      placeholder={value.placeholder}
      onChange={(e) => onChange?.({ ...value, value: e.target.value })}
    />
  );
}

function NumberForm({ value, onChange }: FP) {
  if (value.enum && value.enum.length > 0)
    return <EnumSelect value={value} onChange={onChange} toValue={(s) => Number(s)} />;

  return (
    <Input
      type="number"
      className="h-7 text-xs"
      value={String(value.value ?? 0)}
      onChange={(e) => onChange?.({ ...value, value: Number(e.target.value) })}
    />
  );
}

function IntegerForm({ value, onChange }: FP) {
  return (
    <Input
      type="number"
      step="1"
      className="h-7 text-xs"
      value={String(value.value ?? 0)}
      onChange={(e) => onChange?.({ ...value, value: Math.round(Number(e.target.value)) })}
    />
  );
}

function BooleanForm({ value, onChange }: FP) {
  return (
    <Switch
      checked={!!value.value}
      onCheckedChange={(checked) => onChange?.({ ...value, value: checked })}
    />
  );
}

function ImageForm({ value, onChange }: FP) {
  const src = typeof value.value === 'string' ? value.value : '';
  return (
    <div className="space-y-2">
      <Input
        className="h-7 text-xs"
        value={src}
        placeholder="Image URL"
        onChange={(e) => onChange?.({ ...value, value: e.target.value })}
      />
      {src && <img src={src} className="max-w-full max-h-[120px] rounded object-contain" />}
    </div>
  );
}

function UriForm({ value, onChange }: FP) {
  const url = String(value.value ?? '');
  return (
    <div className="space-y-1">
      <Input
        className="h-7 text-xs"
        value={url}
        placeholder={value.placeholder ?? 'https://...'}
        onChange={(e) => onChange?.({ ...value, value: e.target.value })}
      />
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener"
          className="text-[10px] text-primary hover:underline truncate block"
        >
          {url}
        </a>
      )}
    </div>
  );
}

// ── Simple typed inputs (email / tel / date / date-time / color / password) ──

function EmailForm({ value, onChange }: FP) {
  return (
    <Input
      type="email"
      className="h-7 text-xs"
      value={String(value.value ?? '')}
      placeholder={value.placeholder ?? 'name@example.com'}
      onChange={(e) => onChange?.({ ...value, value: e.target.value })}
    />
  );
}

function EmailView({ value }: FP) {
  const v = String(value.value ?? '');
  return v ? (
    <a href={`mailto:${v}`} className="text-xs text-primary hover:underline truncate block">
      {v}
    </a>
  ) : null;
}

function TelForm({ value, onChange }: FP) {
  return (
    <Input
      type="tel"
      className="h-7 text-xs"
      value={String(value.value ?? '')}
      placeholder={value.placeholder ?? '+1 555 0100'}
      onChange={(e) => onChange?.({ ...value, value: e.target.value })}
    />
  );
}

function TelView({ value }: FP) {
  const v = String(value.value ?? '');
  return v ? (
    <a href={`tel:${v}`} className="text-xs text-primary hover:underline">
      {v}
    </a>
  ) : null;
}

function DateForm({ value, onChange }: FP) {
  return (
    <Input
      type="date"
      className="h-7 text-xs"
      value={String(value.value ?? '')}
      onChange={(e) => onChange?.({ ...value, value: e.target.value })}
    />
  );
}

function DateTimeForm({ value, onChange }: FP) {
  // HTML `datetime-local` expects `YYYY-MM-DDTHH:mm`; schemas commonly store ISO strings with a Z.
  const raw = typeof value.value === 'string' ? value.value : '';
  const local = raw ? dayjs(raw).format('YYYY-MM-DDTHH:mm') : '';
  return (
    <Input
      type="datetime-local"
      className="h-7 text-xs"
      value={local}
      onChange={(e) =>
        onChange?.({ ...value, value: e.target.value ? dayjs(e.target.value).toISOString() : '' })
      }
    />
  );
}

function DateView({ value }: FP) {
  if (isEmpty(value.value)) return <EmptyValue />;
  const v = String(value.value ?? '');
  return <span className="text-xs tabular-nums text-foreground/70">{v || '—'}</span>;
}

function ColorForm({ value, onChange }: FP) {
  const v = typeof value.value === 'string' && value.value ? value.value : '#86efac';
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        className="h-7 w-10 rounded border border-border bg-transparent cursor-pointer"
        value={v}
        onChange={(e) => onChange?.({ ...value, value: e.target.value })}
      />
      <Input
        className="h-7 text-xs font-mono flex-1"
        value={String(value.value ?? '')}
        placeholder="#rrggbb"
        onChange={(e) => onChange?.({ ...value, value: e.target.value })}
      />
    </div>
  );
}

function ColorView({ value }: FP) {
  const v = String(value.value ?? '');
  if (!v) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <div className="flex items-center gap-2">
      <span
        className="h-4 w-4 rounded border border-border shrink-0"
        style={{ backgroundColor: v }}
      />
      <span className="text-xs font-mono text-foreground/70">{v}</span>
    </div>
  );
}

function PasswordForm({ value, onChange }: FP) {
  return (
    <Input
      type="password"
      className="h-7 text-xs font-mono"
      value={String(value.value ?? '')}
      placeholder={value.placeholder ?? '••••••••'}
      onChange={(e) => onChange?.({ ...value, value: e.target.value })}
    />
  );
}

function PasswordView({ value }: FP) {
  const v = String(value.value ?? '');
  return <span className="text-xs font-mono text-foreground/70">{v ? '••••••••' : '—'}</span>;
}

// ── Tags: string array with inline chips ──

function TagsForm({ value, onChange }: FP) {
  const [input, setInput] = useState('');
  const arr = Array.isArray(value.value) ? (value.value as unknown[]).map(String) : [];
  const emit = (next: string[]) => onChange?.({ ...value, value: next });
  return (
    <div className="flex-1 space-y-1">
      {arr.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {arr.map((tag, i) => (
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
                onClick={() => emit(arr.filter((_, j) => j !== i))}
              >
                <X className="h-3 w-3" />
              </Button>
            </span>
          ))}
        </div>
      )}
      <Input
        className="h-7 text-xs w-full"
        placeholder={value.placeholder ?? 'Add tag...'}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          const t = input.trim();
          if (t && !arr.includes(t)) emit([...arr, t]);
          setInput('');
        }}
      />
    </div>
  );
}

function TagsView({ value }: FP) {
  const arr = Array.isArray(value.value) ? (value.value as unknown[]).map(String) : [];
  if (arr.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {arr.map((tag, i) => (
        <span
          key={i}
          className="text-[11px] font-mono bg-muted text-foreground/70 px-1.5 py-0.5 rounded"
        >
          {tag}
        </span>
      ))}
    </div>
  );
}

// ── Translated string: { ru: '...', en: '...', ... } ──

function TstringForm({ value, onChange }: FP) {
  const obj = (
    typeof value.value === 'object' && value.value !== null ? value.value : {}
  ) as Record<string, string>;
  const entries = Object.entries(obj);
  const [newLang, setNewLang] = useState('');
  const emit = (next: Record<string, string>) => onChange?.({ ...value, value: next });

  return (
    <div className="space-y-1">
      {entries.map(([lang, text]) => (
        <div key={lang} className="flex gap-1 items-start">
          <span className="text-[10px] font-mono text-muted-foreground w-8 pt-1.5 shrink-0">
            {lang}
          </span>
          <Input
            className="h-7 text-xs flex-1"
            value={text}
            onChange={(e) => emit({ ...obj, [lang]: e.target.value })}
          />
          <Button
            variant="ghost"
            size="icon"
            type="button"
            className="h-7 w-7 p-0 text-muted-foreground/40 hover:text-foreground shrink-0"
            onClick={() => {
              const next = { ...obj };
              delete next[lang];
              emit(next);
            }}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      ))}
      <div className="flex gap-1">
        <Input
          className="h-7 text-[10px] font-mono w-12 shrink-0"
          placeholder="lang"
          value={newLang}
          onChange={(e) => setNewLang(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const l = newLang.trim().toLowerCase();
            if (l && !(l in obj)) {
              emit({ ...obj, [l]: '' });
              setNewLang('');
            }
          }}
        />
        <span className="text-[10px] text-muted-foreground self-center">
          press Enter to add language
        </span>
      </div>
    </div>
  );
}

function TstringView({ value }: FP) {
  const obj = (
    typeof value.value === 'object' && value.value !== null ? value.value : {}
  ) as Record<string, string>;
  const entries = Object.entries(obj);
  if (entries.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <div className="space-y-0.5">
      {entries.map(([lang, text]) => (
        <div key={lang} className="flex gap-2 text-[11px]">
          <span className="font-mono text-muted-foreground shrink-0 w-6">{lang}</span>
          <span className="text-foreground/70 truncate">{text}</span>
        </div>
      ))}
    </div>
  );
}

function TimestampForm({ value, onChange }: FP) {
  const ts = Number(value.value ?? 0);
  const formatted = ts ? dayjs(ts > 1e12 ? ts : ts * 1000).format('YYYY-MM-DD HH:mm:ss') : '—';
  return (
    <div className="flex items-center gap-2">
      <Input
        type="number"
        className="h-7 text-xs flex-1"
        value={String(ts)}
        onChange={(e) => onChange?.({ ...value, value: Number(e.target.value) })}
      />
      <span className="text-[10px] text-muted-foreground whitespace-nowrap">{formatted}</span>
    </div>
  );
}

function SelectForm({ value, onChange }: FP) {
  const opts = value.enum ?? [];
  return (
    <Select
      value={String(value.value ?? '')}
      onValueChange={(v) => onChange?.({ ...value, value: v })}
    >
      <SelectTrigger size="xs" className="font-mono">
        <SelectValue placeholder="—" />
      </SelectTrigger>
      <SelectContent size="xs">
        {opts.map((v) => (
          <SelectItem key={String(v)} value={String(v)}>
            {String(v)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ObjectForm({ value, onChange }: FP) {
  const [mode, setMode] = useState<'fields' | 'json'>('fields');
  const [jsonDraft, setJsonDraft] = useState('');
  const [jsonError, setJsonError] = useState(false);
  const [newKey, setNewKey] = useState('');
  const obj = (
    typeof value.value === 'object' && value.value !== null ? value.value : {}
  ) as Record<string, unknown>;
  const emit = (next: Record<string, unknown>) => onChange?.({ ...value, value: next });
  const entries = Object.entries(obj);

  const modeToggle = (
    <div className="flex gap-1 mb-1">
      <Button
        variant="ghost"
        size="sm"
        type="button"
        className={`h-6 px-2 text-[10px] ${mode === 'fields' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
        onClick={() => setMode('fields')}
      >
        Fields
      </Button>
      <Button
        variant="ghost"
        size="sm"
        type="button"
        className={`h-6 px-2 text-[10px] ${mode === 'json' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
        onClick={() => {
          setJsonDraft(JSON.stringify(obj, null, 2));
          setJsonError(false);
          setMode('json');
        }}
      >
        JSON
      </Button>
    </div>
  );

  if (mode === 'json') {
    return (
      <div className="rounded border border-border/50 bg-muted/30 p-2">
        {modeToggle}
        <DraftTextarea
          className={`text-[11px] min-h-[60px] ${jsonError ? 'border-destructive' : ''}`}
          value={jsonDraft}
          onChange={(text) => {
            setJsonDraft(text);
            try {
              const parsed = JSON.parse(text);
              if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                emit(parsed);
                setJsonError(false);
              } else {
                setJsonError(true);
              }
            } catch {
              setJsonError(true);
            }
          }}
        />
      </div>
    );
  }

  return (
    <div className="rounded border border-border/50 bg-muted/30 p-2">
      {modeToggle}

      {entries.length > 0 && (
        <div className="space-y-1 mb-1.5">
          {entries.map(([k, v]) => (
            <div key={k} className="flex gap-1.5 items-start group">
              <span className="text-[11px] font-mono text-muted-foreground pt-[5px] min-w-[50px] truncate shrink-0">
                {k}
              </span>
              {typeof v === 'boolean' ? (
                <Switch
                  className="mt-1"
                  checked={v}
                  onCheckedChange={(checked) => emit({ ...obj, [k]: checked })}
                />
              ) : typeof v === 'number' ? (
                <Input
                  type="number"
                  className="h-7 text-[11px] flex-1 min-w-0"
                  value={String(v)}
                  onChange={(e) => emit({ ...obj, [k]: Number(e.target.value) })}
                />
              ) : typeof v === 'string' ? (
                <Input
                  className="h-7 text-[11px] flex-1 min-w-0"
                  value={v}
                  onChange={(e) => emit({ ...obj, [k]: e.target.value })}
                />
              ) : (
                <DraftTextarea
                  className="flex-1 min-w-0 text-[11px] font-mono min-h-[40px]"
                  value={JSON.stringify(v, null, 2)}
                  onChange={(text) => {
                    try {
                      emit({ ...obj, [k]: JSON.parse(text) });
                    } catch {
                      /* typing */
                    }
                  }}
                />
              )}
              <Button
                variant="ghost"
                size="icon"
                type="button"
                className="h-5 w-5 p-0 mt-1 text-muted-foreground/30 opacity-0 group-hover:opacity-100 hover:text-destructive shrink-0 transition-opacity"
                onClick={() => {
                  const next = { ...obj };
                  delete next[k];
                  emit(next);
                }}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-1 items-center border-t border-border/30 pt-1.5">
        <Input
          className="h-7 text-[11px] flex-1 min-w-0 bg-transparent border-dashed"
          placeholder="new key..."
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const k = newKey.trim();
            if (k && !(k in obj)) {
              emit({ ...obj, [k]: '' });
              setNewKey('');
            }
          }}
        />
        <Button
          variant="ghost"
          size="sm"
          type="button"
          className="h-6 px-2 text-[10px] text-muted-foreground hover:text-foreground shrink-0"
          onClick={() => {
            const k = newKey.trim();
            if (k && !(k in obj)) {
              emit({ ...obj, [k]: '' });
              setNewKey('');
            }
          }}
        >
          +
        </Button>
      </div>
    </div>
  );
}

function ArrayForm({ value, onChange }: FP) {
  const [input, setInput] = useState('');
  const arr = Array.isArray(value.value) ? (value.value as unknown[]) : [];
  const schemaType = value.items?.type;
  const sniffed =
    arr.length > 0
      ? typeof arr[0] === 'object' && arr[0] !== null
        ? 'object'
        : typeof arr[0] === 'number'
          ? 'number'
          : typeof arr[0] === 'boolean'
            ? 'boolean'
            : 'string'
      : undefined;
  const itemType = schemaType ?? sniffed ?? 'string';
  const emit = (next: unknown[]) => onChange?.({ ...value, value: next });

  if (itemType === 'string') {
    return (
      <div className="rounded border border-border/50 bg-muted/30 p-2 space-y-1.5">
        {arr.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {(arr as string[]).map((tag, i) => (
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
                  onClick={() => emit(arr.filter((_, j) => j !== i))}
                >
                  ×
                </Button>
              </span>
            ))}
          </div>
        )}
        <Input
          className="h-7 text-[11px] bg-transparent border-dashed"
          placeholder="add item..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const t = input.trim();
            if (t && !(arr as string[]).includes(t)) emit([...arr, t]);
            setInput('');
          }}
        />
      </div>
    );
  }

  if (itemType === 'number') {
    return (
      <div className="rounded border border-border/50 bg-muted/30 p-2 space-y-1">
        {arr.map((item, i) => (
          <div key={i} className="flex gap-1 items-center group">
            <Input
              type="number"
              className="h-7 text-[11px] flex-1"
              value={String(item ?? 0)}
              onChange={(e) => emit(arr.map((v, j) => (j === i ? Number(e.target.value) : v)))}
            />
            <Button
              variant="ghost"
              size="icon"
              type="button"
              className="h-5 w-5 p-0 text-muted-foreground/30 opacity-0 group-hover:opacity-100 hover:text-destructive transition-opacity"
              onClick={() => emit(arr.filter((_, j) => j !== i))}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        ))}
        <Button
          variant="ghost"
          size="sm"
          type="button"
          className="h-6 px-2 text-[10px] text-muted-foreground hover:text-foreground"
          onClick={() => emit([...arr, 0])}
        >
          + add
        </Button>
      </div>
    );
  }

  // object/other — textarea fallback
  return (
    <DraftTextarea
      value={JSON.stringify(arr, null, 2)}
      onChange={(text) => {
        try {
          emit(JSON.parse(text));
        } catch {
          /* let user keep typing */
        }
      }}
    />
  );
}

// ── Path field — node reference with drag-and-drop + tree picker ──

function PathView({ value }: FP) {
  const path = String(value.value ?? '');
  if (!path) return <span className="text-xs text-muted-foreground">—</span>;
  return <span className="text-xs font-mono text-primary truncate block">{path}</span>;
}

// Compact tree picker dropdown for selecting a node path
// Lazy-loads children via trpc on expand, caches into front/cache
export function MiniTree({ onSelect }: { onSelect: (path: string) => void }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['/']));
  const [loaded, setLoaded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');

  // subscribe to cache changes for reactivity
  useSyncExternalStore(
    useCallback((cb: () => void) => cache.subscribeGlobal(cb), []),
    useCallback(() => cache.getVersion(), []),
  );

  // Load root children on mount
  useEffect(() => {
    fetchChildren('/');
  }, []);

  async function fetchChildren(path: string) {
    if (loaded.has(path)) return;
    const { items } = await clientStore.getChildren(path);
    cache.replaceChildren(path, items);
    setLoaded((prev) => new Set(prev).add(path));
  }

  function toggleExpand(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        fetchChildren(path);
      }
      return next;
    });
  }

  const nodes = cache.raw();
  const lf = filter.toLowerCase();

  function getKids(path: string): string[] {
    return cache
      .getChildren(path)
      .map((n) => n.$path)
      .filter((p) => p !== path)
      .sort();
  }

  function matchesFilter(path: string): boolean {
    if (!lf) return true;
    const n = nodes.get(path);
    if (!n) return false;
    const name = path === '/' ? '/' : path.slice(path.lastIndexOf('/') + 1);
    return name.toLowerCase().includes(lf) || n.$type.toLowerCase().includes(lf);
  }

  function hasMatch(path: string): boolean {
    if (matchesFilter(path)) return true;
    for (const c of getKids(path)) {
      if (hasMatch(c)) return true;
    }
    return false;
  }

  function renderNode(path: string, depth: number) {
    if (!hasMatch(path)) return null;
    const n = nodes.get(path);
    if (!n) return null;
    const name = path === '/' ? '/' : path.slice(path.lastIndexOf('/') + 1);
    const kids = getKids(path);
    const isExp = expanded.has(path);
    const hasKids = kids.length > 0 || !loaded.has(path);

    return (
      <div key={path}>
        <div
          className="flex items-center gap-1 px-1 py-0.5 hover:bg-muted/60 cursor-pointer rounded text-[11px]"
          style={{ paddingLeft: depth * 12 + 4 }}
          onClick={() => onSelect(path)}
        >
          {hasKids ? (
            <span
              className="text-muted-foreground w-3 text-center shrink-0 cursor-pointer"
              onClick={(e) => {
                e.stopPropagation();
                toggleExpand(path);
              }}
            >
              {isExp ? '\u25BE' : '\u25B8'}
            </span>
          ) : (
            <span className="w-3 shrink-0" />
          )}
          <span className="truncate">{name}</span>
          <span className="text-muted-foreground text-[10px] ml-auto shrink-0">
            {n.$type.includes('.') ? n.$type.slice(n.$type.lastIndexOf('.') + 1) : n.$type}
          </span>
        </div>
        {isExp && kids.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  }

  const rootKids = getKids('/');
  const rootNode = nodes.get('/');

  return (
    <>
      <div className="p-1.5 border-b border-border">
        <Input
          className="h-7 text-[11px] w-full"
          placeholder="Filter..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          autoFocus
        />
      </div>
      <div className="p-1">
        {rootNode && renderNode('/', 0)}
        {!rootNode && rootKids.map((r) => renderNode(r, 0))}
      </div>
    </>
  );
}

// Inline typed editor for embedded object values
function EmbeddedFields({
  data,
  type,
  setData,
}: {
  data: Record<string, unknown>;
  type: string;
  setData: (fn: (prev: Record<string, unknown>) => Record<string, unknown>) => void;
}) {
  const schema = useSchema(type);
  if (schema === undefined) return null; // loading

  if (schema && Object.keys(schema.properties).length > 0) {
    return (
      <div className="space-y-1.5">
        {Object.entries(schema.properties).map(([field, prop]) => {
          const p = prop as {
            type: string;
            title: string;
            format?: string;
            description?: string;
            readOnly?: boolean;
            enum?: (string | number)[];
            enumNames?: string[];
            items?: { type?: string };
          };
          // Resolve: format widget → base type → generic string. Unknown format must
          // not mask the underlying structural type.
          const resolvedType =
            (p.format && resolveHandler(p.format, 'react:form') ? p.format : null) ??
            (resolveHandler(p.type, 'react:form') ? p.type : null) ??
            'string';
          if (resolvedType === 'path') return null; // avoid infinite nesting for now
          const handler = resolveHandler(resolvedType, 'react:form');
          if (!handler) return null;
          const fieldData = {
            $type: resolvedType,
            value: data[field],
            label: p.title ?? field,
            placeholder: p.description,
            ...(p.items ? { items: p.items } : {}),
            ...(p.enum ? { enum: p.enum } : {}),
            ...(p.enumNames ? { enumNames: p.enumNames } : {}),
          };
          return (
            <div key={field} className="field">
              <label title={p.title ?? p.description}>{field}</label>
              {createElement(handler as any, {
                value: fieldData,
                onChange: p.readOnly
                  ? undefined
                  : (next: { value: unknown }) =>
                      setData((prev) => ({ ...prev, [field]: next.value })),
              })}
            </div>
          );
        })}
      </div>
    );
  }

  // No schema — render plain key/value fields
  const entries = Object.entries(data).filter(([k]) => !k.startsWith('$'));
  if (entries.length === 0) return null;
  return (
    <div className="space-y-1">
      {entries.map(([k, v]) => (
        <div key={k} className="field">
          <label>{k}</label>
          <Input
            className="h-7 text-[11px]"
            value={typeof v === 'string' ? v : JSON.stringify(v)}
            onChange={(e) => setData((prev) => ({ ...prev, [k]: e.target.value }))}
          />
        </div>
      ))}
    </div>
  );
}

function PathForm({ value, onChange }: FP) {
  const raw = value.value;
  const refType = value.refType; // expected component type from schema
  const isValue = typeof raw === 'object' && raw !== null;
  const refPath = isValue
    ? String((raw as Record<string, unknown>).$path ?? '')
    : String(raw ?? '');
  const embeddedType = isValue ? String((raw as Record<string, unknown>).$type ?? '') : '';
  const effectiveType = embeddedType || refType || '';
  const [mode, setMode] = useState<'ref' | 'val'>(isValue ? 'val' : 'ref');
  const [dragOver, setDragOver] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  function setRef(p: string) {
    onChange?.({ ...value, value: p });
  }

  async function setByValue(p: string) {
    const node = await clientStore.get(p);
    if (!node) return;
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === '$rev') continue;
      copy[k] = v;
    }
    onChange?.({ ...value, value: copy });
  }

  // Create empty embedded object from refType schema
  function createEmpty() {
    if (!refType) return;
    onChange?.({ ...value, value: { $type: refType } });
  }

  function applyNode(path: string) {
    if (mode === 'val') setByValue(path);
    else setRef(path);
  }

  function updateEmbedded(fn: (prev: Record<string, unknown>) => Record<string, unknown>) {
    if (!isValue) return;
    const obj = raw as Record<string, unknown>;
    onChange?.({ ...value, value: fn({ ...obj }) });
  }

  const hasValue = isValue || !!refPath;

  return (
    <div ref={wrapRef} className="relative">
      <div
        className={`rounded border transition-colors ${
          dragOver ? 'border-primary ring-2 ring-primary/30 bg-primary/5' : 'border-border'
        }`}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('application/treenix-path')) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'link';
            setDragOver(true);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const dropped = e.dataTransfer.getData('application/treenix-path');
          if (dropped) applyNode(dropped);
        }}
      >
        {/* Header row: mode switch + input + controls */}
        <div className="flex items-center gap-1">
          {/* Mode toggle — always visible */}
          <Button
            variant="ghost"
            size="sm"
            type="button"
            className={`h-6 px-1 text-[10px] font-bold font-mono shrink-0 ${
              mode === 'val' ? 'text-amber-500' : 'text-primary'
            }`}
            onClick={() => {
              if (mode === 'ref') {
                setMode('val');
                if (refPath) setByValue(refPath);
                else if (!isValue) createEmpty();
              } else {
                setMode('ref');
                if (refPath) setRef(refPath);
              }
            }}
            title={mode === 'val' ? 'Value mode — embeds node data' : 'Ref mode — stores path'}
          >
            {mode}
          </Button>

          {/* Type badge when refType is known */}
          {refType && (
            <span className="text-[9px] text-muted-foreground font-mono shrink-0">
              {refType.includes('.') ? refType.slice(refType.lastIndexOf('.') + 1) : refType}
            </span>
          )}

          {isValue ? (
            <span className="flex-1 min-w-0 text-[11px] font-mono text-foreground/70 truncate py-1">
              {refPath && <span className="text-muted-foreground">{refPath}</span>}
              {embeddedType && <span className="ml-1 text-amber-500">{embeddedType}</span>}
            </span>
          ) : (
            <Input
              className="h-7 text-[11px] font-mono flex-1 min-w-0 border-0 bg-transparent"
              value={refPath}
              placeholder="drop or pick a node"
              onChange={(e) => setRef(e.target.value)}
            />
          )}

          {hasValue && (
            <Button
              variant="ghost"
              size="icon"
              type="button"
              className="h-5 w-5 p-0 text-muted-foreground/40 hover:text-foreground shrink-0"
              onClick={() => {
                onChange?.({ ...value, value: '' });
                setMode('ref');
              }}
            >
              <X className="h-3 w-3" />
            </Button>
          )}
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                type="button"
                className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground shrink-0 text-[11px]"
                title="Browse tree"
              >
                &#9776;
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64 max-h-60 overflow-auto p-0">
              <MiniTree
                onSelect={(p) => {
                  applyNode(p);
                  setPickerOpen(false);
                }}
              />
            </PopoverContent>
          </Popover>
        </div>

        {/* Inline typed editor for embedded value */}
        {isValue && (
          <div className="border-t border-border/50 p-2">
            <EmbeddedFields
              data={raw as Record<string, unknown>}
              type={effectiveType}
              setData={updateEmbedded}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Registration ──
// Each entry: [type, viewHandler, formHandler]

const fields: [string, Function, Function][] = [
  ['string', StringView, StringForm],
  ['text', StringView, TextForm],
  ['textarea', StringView, TextForm],
  ['number', NumberView, NumberForm],
  ['integer', NumberView, IntegerForm],
  ['boolean', BooleanView, BooleanForm],
  ['array', ArrayView, ArrayForm],
  ['object', ObjectView, ObjectForm],
  ['image', ImageView, ImageForm],
  ['uri', UriView, UriForm],
  ['url', UriView, UriForm],
  ['select', StringView, SelectForm],
  ['timestamp', TimestampView, TimestampForm],
  ['path', PathView, PathForm],
  ['email', EmailView, EmailForm],
  ['tel', TelView, TelForm],
  ['date', DateView, DateForm],
  ['date-time', DateView, DateTimeForm],
  ['color', ColorView, ColorForm],
  ['password', PasswordView, PasswordForm],
  ['tags', TagsView, TagsForm],
  ['tstring', TstringView, TstringForm],
];

export function registerFormFields() {
  for (const [type, view, form] of fields) {
    register(type, 'react', view as any);
    register(type, 'react:form', form as any);
  }
}
