import { type ComponentData, isComponent, type NodeData, register } from '@treenx/core';
import type { TypeSchema } from '@treenx/core/schema/types';
import { useCurrentNode } from '@treenx/react';
import { useChildren } from '@treenx/react';
import { useSchema } from '@treenx/react/schema-loader';
import { Button } from '@treenx/react/ui/button';
import { Checkbox } from '@treenx/react/ui/checkbox';
import { Input } from '@treenx/react/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@treenx/react/ui/select';
import { useMemo, useState } from 'react';
import type { UITable } from './types';

// ── Field tree types ──

type FieldNode = {
  key: string;
  label: string;
  type?: string;
  children?: FieldNode[];
};

// ── Build field tree from schema + data sample ──

function buildFieldTree(schema: TypeSchema | null, sample: Record<string, unknown>[]): FieldNode[] {
  const nodes: FieldNode[] = [];
  const seen = new Set<string>();

  if (schema?.properties) {
    for (const [key, prop] of Object.entries(schema.properties)) {
      if (key.startsWith('$')) continue;
      seen.add(key);
      nodes.push({ key, label: (prop as any).title || key });
    }
  }

  for (const row of sample.slice(0, 10)) {
    for (const [key, val] of Object.entries(row)) {
      if (key.startsWith('$') || seen.has(key)) continue;
      seen.add(key);

      if (isComponent(val)) {
        const children = Object.keys(val)
          .filter(k => !k.startsWith('$'))
          .map(k => ({ key: `${key}.${k}`, label: k }));
        nodes.push({ key, label: key, type: val.$type, children });
      } else {
        nodes.push({ key, label: key });
      }
    }
  }

  return nodes;
}

// ── Helpers ──

function resolveDisplayType(child: NodeData, field: string): string {
  if (!field) return child.$type;
  const val = (child as any)[field];
  return val?.$type ?? '';
}

// ── Edit View ──

function TableEditView({ value, onChange }: { value: ComponentData; onChange?: (next: Record<string, unknown>) => void }) {
  const node = useCurrentNode();
  const { data: children } = useChildren(node.$path, { watch: true, limit: 1000 });

  const state = value as unknown as UITable;
  const emit = (patch: Partial<UITable>) => {
    if (!onChange) return;
    onChange(patch);
  };

  // Detect types
  const { types, typeMap } = useMemo(() => {
    const map = new Map<string, NodeData[]>();
    for (const child of children) {
      const dt = resolveDisplayType(child, state.field ?? '');
      if (!dt) continue;
      const arr = map.get(dt) ?? [];
      arr.push(child);
      map.set(dt, arr);
    }
    return { typeMap: map, types: [...map.keys()] };
  }, [children, state.field]);

  const activeType = state.displayType && types.includes(state.displayType)
    ? state.displayType
    : types[0] ?? '';

  const sample = useMemo(() => {
    const matched = typeMap.get(activeType) ?? [];
    return matched.slice(0, 10) as Record<string, unknown>[];
  }, [typeMap, activeType]);

  const schema = useSchema(activeType);
  const fieldTree = useMemo(() => buildFieldTree(schema ?? null, sample), [schema, sample]);

  const savedColumns = state.columns?.[activeType] ?? [];
  const hasCustomColumns = savedColumns.length > 0;

  const toggleField = (key: string, label: string) => {
    let cols = savedColumns.length > 0 ? [...savedColumns] : fieldTree.map(f => ({ field: f.key, label: f.label, visible: true }));
    const idx = cols.findIndex(c => c.field === key);
    if (idx >= 0) {
      cols[idx] = { ...cols[idx], visible: !cols[idx].visible };
    } else {
      cols.push({ field: key, label, visible: true });
    }
    emit({ columns: { ...state.columns, [activeType]: cols } });
  };

  const resetColumns = () => {
    const next = { ...state.columns };
    delete next[activeType];
    emit({ columns: next });
  };

  const isFieldVisible = (key: string) => {
    if (!hasCustomColumns) return true;
    const col = savedColumns.find(c => c.field === key);
    return col?.visible !== false;
  };

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpand = (key: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-3 text-xs">
      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2">
          <span className="w-20 text-muted-foreground">Page size</span>
          <Input
            type="number"
            min={1}
            max={1000}
            className="h-7 w-20 text-xs"
            value={state.pageSize ?? 25}
            onChange={e => emit({ pageSize: Number(e.target.value) || 25 })}
          />
        </label>

        <label className="flex items-center gap-2">
          <span className="w-20 text-muted-foreground">Field</span>
          <Input
            type="text"
            placeholder="(node itself)"
            className="h-7 flex-1 text-xs"
            value={state.field ?? ''}
            onChange={e => emit({ field: e.target.value })}
          />
        </label>

        {types.length > 1 && (
          <div className="flex items-center gap-2">
            <span className="w-20 text-muted-foreground">Type</span>
            <Select value={activeType} onValueChange={v => emit({ displayType: v })}>
              <SelectTrigger className="h-7 flex-1 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {types.map(t => (
                  <SelectItem key={t} value={t}>{t} ({typeMap.get(t)?.length ?? 0})</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="font-medium text-muted-foreground">Columns{activeType ? ` — ${activeType}` : ''}</span>
          {hasCustomColumns && (
            <Button variant="ghost" size="sm" className="h-5 text-[10px]" onClick={resetColumns}>
              reset
            </Button>
          )}
        </div>

        {fieldTree.length === 0 && (
          <div className="py-2 text-muted-foreground">No fields detected</div>
        )}

        <div className="flex flex-col gap-0.5">
          {fieldTree.map(field => (
            <div key={field.key}>
              <div className="flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-muted/50">
                {field.children ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-4 w-4 p-0 text-muted-foreground"
                    onClick={() => toggleExpand(field.key)}
                  >
                    {expanded.has(field.key) ? '▾' : '▸'}
                  </Button>
                ) : (
                  <span className="w-4" />
                )}
                <label className="flex flex-1 cursor-pointer items-center gap-1.5">
                  <Checkbox
                    checked={isFieldVisible(field.key)}
                    onChange={() => toggleField(field.key, field.label)}
                  />
                  <span>{field.label}</span>
                  {field.type && (
                    <span className="text-[10px] text-muted-foreground/50">{field.type}</span>
                  )}
                </label>
              </div>

              {field.children && expanded.has(field.key) && (
                <div className="ml-5 flex flex-col gap-0.5">
                  {field.children.map(sub => (
                    <label key={sub.key} className="flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-muted/50">
                      <Checkbox
                        checked={isFieldVisible(sub.key)}
                        onChange={() => toggleField(sub.key, sub.label)}
                      />
                      <span>{sub.label}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

register('ui.table', 'react:edit', TableEditView as any);
