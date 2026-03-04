// react:form handlers — editable fields for inspector panel
import * as cache from '#cache';
import { tree as clientStore } from '#client';
import { useSchema } from '#schema-loader';
// react view handlers — readOnly display for same types
// Covers: string, text, textarea, number, integer, boolean, array, object, image, uri, url, select, timestamp, path
import { register, resolve as resolveHandler } from '@treenity/core/core';
import dayjs from 'dayjs';
import { X } from 'lucide-react';
import { createElement, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

type FP = {
  value: {
    $type: string;
    value: unknown;
    label?: string;
    placeholder?: string;
    enum?: string[];
    items?: { type?: string };
    refType?: string; // component type — field can hold ref or embedded value of this type
  };
  onChange?: (next: any) => void;
};

// ── View handlers (react context) — readOnly display ──

function StringView({ value }: FP) {
  return <span className="text-xs text-foreground/70">{String(value.value ?? '')}</span>;
}

function NumberView({ value }: FP) {
  return <span className="text-xs font-mono text-foreground/70">{String(value.value ?? 0)}</span>;
}

function BooleanView({ value }: FP) {
  return <span className="text-xs text-foreground/70">{value.value ? 'true' : 'false'}</span>;
}

function ImageView({ value }: FP) {
  const src = typeof value.value === 'string' ? value.value : '';
  return src ? <img src={src} className="max-w-full max-h-[120px] rounded object-contain" /> : null;
}

function UriView({ value }: FP) {
  const url = String(value.value ?? '');
  return url
    ? <a href={url} target="_blank" rel="noopener" className="text-xs text-primary hover:underline truncate block">{url}</a>
    : null;
}

function TimestampView({ value }: FP) {
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
          <span key={i} className="text-[11px] font-mono bg-muted text-foreground/70 px-1.5 py-0.5 rounded">{tag}</span>
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
  const obj = (typeof value.value === 'object' && value.value !== null ? value.value : {}) as Record<string, unknown>;
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

function StringForm({ value, onChange }: FP) {
  // enum → select dropdown
  if (value.enum && value.enum.length > 0) {
    return (
      <select
        value={String(value.value ?? '')}
        onChange={(e) => onChange?.({ ...value, value: e.target.value })}
      >
        <option value="">—</option>
        {value.enum.map((v) => (
          <option key={v} value={v}>{v}</option>
        ))}
      </select>
    );
  }

  return (
    <input
      value={String(value.value ?? '')}
      placeholder={value.placeholder}
      onChange={(e) => onChange?.({ ...value, value: e.target.value })}
    />
  );
}

function TextForm({ value, onChange }: FP) {
  return (
    <textarea
      value={String(value.value ?? '')}
      placeholder={value.placeholder}
      onChange={(e) => onChange?.({ ...value, value: e.target.value })}
    />
  );
}

function NumberForm({ value, onChange }: FP) {
  return (
    <input
      type="number"
      value={String(value.value ?? 0)}
      onChange={(e) => onChange?.({ ...value, value: Number(e.target.value) })}
    />
  );
}

function IntegerForm({ value, onChange }: FP) {
  return (
    <input
      type="number"
      step="1"
      value={String(value.value ?? 0)}
      onChange={(e) => onChange?.({ ...value, value: Math.round(Number(e.target.value)) })}
    />
  );
}

function BooleanForm({ value, onChange }: FP) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input
        type="checkbox"
        className="w-auto"
        checked={!!value.value}
        onChange={(e) => onChange?.({ ...value, value: e.target.checked })}
      />
      <span className="text-xs text-muted-foreground">{value.label}</span>
    </label>
  );
}

function ImageForm({ value, onChange }: FP) {
  const src = typeof value.value === 'string' ? value.value : '';
  return (
    <div className="space-y-2">
      <input
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
      <input
        value={url}
        placeholder={value.placeholder ?? 'https://...'}
        onChange={(e) => onChange?.({ ...value, value: e.target.value })}
      />
      {url && (
        <a href={url} target="_blank" rel="noopener" className="text-[10px] text-primary hover:underline truncate block">
          {url}
        </a>
      )}
    </div>
  );
}

function TimestampForm({ value, onChange }: FP) {
  const ts = Number(value.value ?? 0);
  const formatted = ts ? dayjs(ts > 1e12 ? ts : ts * 1000).format('YYYY-MM-DD HH:mm:ss') : '—';
  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        className="flex-1"
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
    <select
      value={String(value.value ?? '')}
      onChange={(e) => onChange?.({ ...value, value: e.target.value })}
    >
      <option value="">—</option>
      {opts.map((v) => (
        <option key={v} value={v}>{v}</option>
      ))}
    </select>
  );
}

function ObjectForm({ value, onChange }: FP) {
  const [mode, setMode] = useState<'fields' | 'json'>('fields');
  const [jsonDraft, setJsonDraft] = useState('');
  const [jsonError, setJsonError] = useState(false);
  const [newKey, setNewKey] = useState('');
  const obj = (typeof value.value === 'object' && value.value !== null ? value.value : {}) as Record<
    string,
    unknown
  >;
  const emit = (next: Record<string, unknown>) => onChange?.({ ...value, value: next });
  const entries = Object.entries(obj);

  const modeToggle = (
    <div className="flex gap-1 mb-1">
      <button
        type="button"
        className={`border-0 px-2 py-0.5 text-[10px] rounded ${mode === 'fields' ? 'bg-muted text-foreground' : 'bg-transparent text-muted-foreground hover:text-foreground'}`}
        onClick={() => setMode('fields')}
      >
        Fields
      </button>
      <button
        type="button"
        className={`border-0 px-2 py-0.5 text-[10px] rounded ${mode === 'json' ? 'bg-muted text-foreground' : 'bg-transparent text-muted-foreground hover:text-foreground'}`}
        onClick={() => {
          setJsonDraft(JSON.stringify(obj, null, 2));
          setJsonError(false);
          setMode('json');
        }}
      >
        JSON
      </button>
    </div>
  );

  if (mode === 'json') {
    return (
      <div className="rounded border border-border/50 bg-muted/30 p-2">
        {modeToggle}
        <textarea
          className={`text-[11px] min-h-[60px] ${jsonError ? 'border-destructive' : ''}`}
          value={jsonDraft}
          onChange={(e) => {
            setJsonDraft(e.target.value);
            try {
              const parsed = JSON.parse(e.target.value);
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
                <input
                  type="checkbox"
                  className="w-auto mt-1.5"
                  checked={v}
                  onChange={(e) => emit({ ...obj, [k]: e.target.checked })}
                />
              ) : typeof v === 'number' ? (
                <input
                  type="number"
                  className="flex-1 min-w-0 text-[11px]"
                  value={String(v)}
                  onChange={(e) => emit({ ...obj, [k]: Number(e.target.value) })}
                />
              ) : typeof v === 'string' ? (
                <input
                  className="flex-1 min-w-0 text-[11px]"
                  value={v}
                  onChange={(e) => emit({ ...obj, [k]: e.target.value })}
                />
              ) : (
                <textarea
                  className="flex-1 min-w-0 text-[11px] font-mono min-h-[40px]"
                  value={JSON.stringify(v, null, 2)}
                  onChange={(e) => {
                    try {
                      emit({ ...obj, [k]: JSON.parse(e.target.value) });
                    } catch {
                      /* typing */
                    }
                  }}
                />
              )}
              <button
                type="button"
                className="border-0 bg-transparent p-0 mt-1 text-muted-foreground/30 opacity-0 group-hover:opacity-100 hover:text-destructive shrink-0 cursor-pointer transition-opacity"
                onClick={() => {
                  const next = { ...obj };
                  delete next[k];
                  emit(next);
                }}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-1 items-center border-t border-border/30 pt-1.5">
        <input
          className="flex-1 min-w-0 text-[11px] bg-transparent border-dashed"
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
        <button
          type="button"
          className="border-0 bg-transparent p-0 text-[11px] text-muted-foreground hover:text-foreground shrink-0 cursor-pointer"
          onClick={() => {
            const k = newKey.trim();
            if (k && !(k in obj)) {
              emit({ ...obj, [k]: '' });
              setNewKey('');
            }
          }}
        >
          +
        </button>
      </div>
    </div>
  );
}

function ArrayForm({ value, onChange }: FP) {
  const [input, setInput] = useState('');
  const arr = Array.isArray(value.value) ? (value.value as unknown[]) : [];
  const itemType = value.items?.type ?? 'string';
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
                <button
                  type="button"
                  className="ml-0.5 border-0 bg-transparent p-0 text-muted-foreground/40 hover:text-foreground leading-none cursor-pointer"
                  onClick={() => emit(arr.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <input
          className="text-[11px] bg-transparent border-dashed"
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
            <input
              type="number"
              className="flex-1 text-[11px]"
              value={String(item ?? 0)}
              onChange={(e) => emit(arr.map((v, j) => (j === i ? Number(e.target.value) : v)))}
            />
            <button
              type="button"
              className="border-0 bg-transparent p-0 text-muted-foreground/30 opacity-0 group-hover:opacity-100 hover:text-destructive cursor-pointer transition-opacity"
              onClick={() => emit(arr.filter((_, j) => j !== i))}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="border-0 bg-transparent p-0 text-[11px] text-muted-foreground hover:text-foreground cursor-pointer"
          onClick={() => emit([...arr, 0])}
        >
          + add
        </button>
      </div>
    );
  }

  // object/other — textarea fallback
  return (
    <textarea
      value={JSON.stringify(arr, null, 2)}
      onChange={(e) => {
        try {
          emit(JSON.parse(e.target.value));
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
export function MiniTree({ onSelect, onClose }: { onSelect: (path: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
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

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  async function fetchChildren(path: string) {
    if (loaded.has(path)) return;
    const { items } = await clientStore.getChildren(path);
    cache.putMany(items, path);
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
    return cache.getChildren(path).map((n) => n.$path).filter((p) => p !== path).sort();
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
    <div
      ref={ref}
      className="absolute z-50 mt-1 w-64 max-h-60 overflow-auto bg-popover border border-border rounded-lg shadow-lg"
    >
      <div className="p-1.5 border-b border-border">
        <input
          className="text-[11px] w-full"
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
    </div>
  );
}

// Inline typed editor for embedded object values
function EmbeddedFields({ data, type, setData }: {
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
            type: string; title: string; format?: string; description?: string;
            readOnly?: boolean; enum?: string[]; items?: { type?: string };
          };
          const fieldType = p.format ?? p.type;
          if (fieldType === 'path') return null; // avoid infinite nesting for now
          const handler = resolveHandler(fieldType, 'react:form') ?? resolveHandler('string', 'react:form');
          if (!handler) return null;
          const fieldData = {
            $type: fieldType,
            value: data[field],
            label: p.title ?? field,
            placeholder: p.description,
            ...(p.items ? { items: p.items } : {}),
            ...(p.enum ? { enum: p.enum } : {}),
          };
          return (
            <div key={field} className="field">
              {fieldType !== 'boolean' && <label>{p.title ?? field}</label>}
              {createElement(handler as any, {
                value: fieldData,
                onChange: p.readOnly
                  ? undefined
                  : (next: { value: unknown }) => setData((prev) => ({ ...prev, [field]: next.value })),
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
          <input
            className="text-[11px]"
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
  const refPath = isValue ? String((raw as Record<string, unknown>).$path ?? '') : String(raw ?? '');
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
          if (e.dataTransfer.types.includes('application/treenity-path')) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'link';
            setDragOver(true);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const dropped = e.dataTransfer.getData('application/treenity-path');
          if (dropped) applyNode(dropped);
        }}
      >
        {/* Header row: mode switch + input + controls */}
        <div className="flex items-center gap-1">
          {/* Mode toggle — always visible */}
          <button
            type="button"
            className={`border-0 bg-transparent p-0 px-1 cursor-pointer shrink-0 text-[10px] font-bold font-mono ${
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
          </button>

          {/* Type badge when refType is known */}
          {refType && (
            <span className="text-[9px] text-muted-foreground font-mono shrink-0">
              {refType.includes('.') ? refType.slice(refType.lastIndexOf('.') + 1) : refType}
            </span>
          )}

          {isValue ? (
            <span className="flex-1 min-w-0 text-[11px] font-mono text-foreground/70 truncate py-1">
              {refPath && <span className="text-muted-foreground">{refPath}</span>}
              {embeddedType && (
                <span className="ml-1 text-amber-500">{embeddedType}</span>
              )}
            </span>
          ) : (
            <input
              className="flex-1 min-w-0 text-[11px] font-mono border-0 bg-transparent"
              value={refPath}
              placeholder="drop or pick a node"
              onChange={(e) => setRef(e.target.value)}
            />
          )}

          {hasValue && (
            <button
              type="button"
              className="border-0 bg-transparent p-0 px-0.5 text-muted-foreground/40 hover:text-foreground cursor-pointer shrink-0"
              onClick={() => { onChange?.({ ...value, value: '' }); setMode('ref'); }}
            >
              <X className="h-3 w-3" />
            </button>
          )}
          <button
            type="button"
            className="border-0 bg-transparent p-0 px-1 text-muted-foreground hover:text-foreground cursor-pointer shrink-0 text-[11px]"
            onClick={() => setPickerOpen((v) => !v)}
            title="Browse tree"
          >
            &#9776;
          </button>
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

      {pickerOpen && (
        <MiniTree
          onSelect={(p) => { applyNode(p); setPickerOpen(false); }}
          onClose={() => setPickerOpen(false)}
        />
      )}
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
];

export function registerFormFields() {
  for (const [type, view, form] of fields) {
    register(type, 'react', view as any);
    register(type, 'react:form', form as any);
  }
}
