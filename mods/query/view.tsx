import type { NodeData } from '@treenity/core';
import { getComponents, register } from '@treenity/core';
import { Render, RenderContext, type View } from '@treenity/react';
import { set, useChildren, useNavigate } from '@treenity/react/hooks';
import { List, Plus, Rows3, Table2, X } from 'lucide-react';
import { Fragment, useMemo, type ReactNode } from 'react';
import { type QueryFilter, QueryView } from './types';

type Mode = QueryView['mode'];

const MODES: { id: Mode; icon: ReactNode; label: string }[] = [
  { id: 'list', icon: <List size={14} />, label: 'List' },
  { id: 'table', icon: <Table2 size={14} />, label: 'Table' },
  { id: 'kanban', icon: <Rows3 size={14} />, label: 'Kanban' },
];

function f(node: NodeData, key: string): string {
  const v = node[key];
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

function matchFilters(node: NodeData, filters: QueryFilter[]): boolean {
  return filters.every(({ field, value }) => {
    if (!field || !value) return true;
    return f(node, field).toLowerCase().includes(value.toLowerCase());
  });
}

function collectFields(nodes: NodeData[]): string[] {
  const keys = new Set<string>();
  for (const node of nodes.slice(0, 30)) {
    for (const k of Object.keys(node)) {
      if (!k.startsWith('$') && k !== 'mount') keys.add(k);
    }
  }
  return [...keys].sort();
}

function groupItems(items: NodeData[], groupBy: string) {
  const map = new Map<string, NodeData[]>();
  for (const node of items) {
    const key = f(node, groupBy);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(node);
  }
  return map;
}

// ── Renderers ──

function ListView({ items }: { items: NodeData[] }) {
  return (
    <RenderContext name="react:list">
      <div className="flex flex-col gap-1.5 p-3">
        {items.map(child => (
          <Render key={String(child.$path)} value={child} />
        ))}
      </div>
    </RenderContext>
  );
}

function TableRows({ items, fields, navigate }: { items: NodeData[]; fields: string[]; navigate: (p: string) => void }) {
  return (
    <>
      {items.map(node => (
        <tr
          key={String(node.$path)}
          onClick={() => navigate(`/t${node.$path}`)}
          className="border-t border-border/50 hover:bg-muted/20 transition-colors cursor-pointer"
        >
          <td className="px-3 py-1.5 font-mono text-emerald-400/80 whitespace-nowrap">
            {String(node.$path).split('/').pop()}
          </td>
          {fields.map(k => (
            <td key={k} className="px-3 py-1.5 text-foreground/80 whitespace-nowrap max-w-48 truncate">
              {f(node, k) || <span className="text-muted-foreground/40">&mdash;</span>}
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

function TableView({ items, groupBy }: { items: NodeData[]; groupBy: string }) {
  const fields = useMemo(() => collectFields(items), [items]);
  const navigate = useNavigate();
  const groups = useMemo(() => groupBy ? groupItems(items, groupBy) : null, [items, groupBy]);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-muted/30 border-b border-border">
            <th className="px-3 py-2 text-left font-semibold text-muted-foreground">name</th>
            {fields.map(k => (
              <th key={k} className="px-3 py-2 text-left font-semibold text-muted-foreground whitespace-nowrap">{k}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups ? (
            [...groups.entries()].map(([group, nodes]) => (
              <Fragment key={group}>
                <tr className="bg-muted/20">
                  <td colSpan={fields.length + 1} className="px-3 py-1.5 text-xs font-semibold text-foreground">
                    {group} <span className="text-muted-foreground font-normal ml-1">{nodes.length}</span>
                  </td>
                </tr>
                <TableRows items={nodes} fields={fields} navigate={navigate} />
              </Fragment>
            ))
          ) : (
            <TableRows items={items} fields={fields} navigate={navigate} />
          )}
        </tbody>
      </table>
    </div>
  );
}

function KanbanView({ items, groupBy }: { items: NodeData[]; groupBy: string }) {
  const groups = useMemo(() => groupItems(items, groupBy), [items, groupBy]);

  return (
    <div className="flex flex-col gap-2 p-3">
      {[...groups.entries()].map(([group, nodes]) => (
        <div key={group} className="rounded-lg border border-border bg-muted/20">
          <div className="px-3 py-2 border-b border-border">
            <span className="text-xs font-semibold text-foreground">{group}</span>
            <span className="ml-2 text-[10px] text-muted-foreground">{nodes.length}</span>
          </div>
          <RenderContext name="react:list">
            <div className="flex flex-col gap-1.5 p-2">
              {nodes.map(child => (
                <Render key={String(child.$path)} value={child} />
              ))}
            </div>
          </RenderContext>
        </div>
      ))}
    </div>
  );
}

// ── Main view ──

const QueryViewComponent: View<QueryView> = ({ value, onChange, ctx }) => {
  const node = ctx?.node;
  const source = value.source || '/';
  const filterType = value.filterType || '';
  const filters = (value.filters as QueryFilter[]) || [];
  const mode = value.mode || 'list';
  const groupBy = value.groupBy || '';

  const update = (partial: Partial<QueryView>) => {
    if (onChange) {
      onChange({ ...value, ...partial });
    } else if (node) {
      set({ ...node, ...partial });
    }
  };

  const hasActiveFilters = !!filterType || filters.some(f => f.field && f.value);
  const children = useChildren(source) ?? [];

  const filtered = useMemo(() => {
    if (!hasActiveFilters) return [];
    let result = [...children];
    if (filterType) result = result.filter(c =>
      getComponents(c).some(([, comp]) => comp.$type === filterType),
    );
    if (filters.length) result = result.filter(c => matchFilters(c, filters));
    return result.slice(0, 50);
  }, [children, filterType, filters, hasActiveFilters]);

  return (
    <div className="rounded-lg border border-border overflow-hidden bg-card">
      {/* Header with mode switcher */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-border">
        <span className="text-xs text-muted-foreground font-mono mr-2">{source}</span>
        {filterType && <span className="px-1.5 py-0.5 rounded bg-accent text-accent-foreground text-[10px]">{filterType}</span>}
        {filters.length > 0 && <span className="text-[10px] text-emerald-400">{filters.length} filter{filters.length > 1 ? 's' : ''}</span>}

        <div className="ml-auto flex items-center gap-0.5">
          {MODES.map(m => (
            <button
              key={m.id}
              onClick={() => update({ mode: m.id })}
              title={m.label}
              className={`p-1.5 rounded transition-colors ${mode === m.id ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {m.icon}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      {!hasActiveFilters ? (
        <div className="px-4 py-8 text-center text-xs text-muted-foreground">
          Set a type or add filters to display results
        </div>
      ) : filtered.length === 0 ? (
        <div className="px-4 py-8 text-center text-xs text-muted-foreground">
          No matches
        </div>
      ) : mode === 'table' ? (
        <TableView items={filtered} groupBy={groupBy} />
      ) : mode === 'kanban' ? (
        <KanbanView items={filtered} groupBy={groupBy} />
      ) : (
        <ListView items={filtered} />
      )}

      {filtered.length > 0 && (
        <div className="px-3 py-1.5 border-t border-border text-[10px] text-muted-foreground text-right">
          {filtered.length}{filtered.length === 50 ? '+' : ''} results
        </div>
      )}
    </div>
  );
};

// ── Edit view (inline fields + results) ──

const inputCls = 'flex-1 bg-muted/30 rounded px-2 py-1 text-xs text-foreground border border-border outline-none focus:border-emerald-500 min-w-0';
const selectCls = 'bg-muted/30 rounded px-2 py-1 text-xs text-foreground border border-border outline-none focus:border-emerald-500 min-w-0 cursor-pointer';

const QueryEditView: View<QueryView> = ({ value, ctx }) => {
  const node = ctx?.node;
  const source = value.source || '/';
  const filterType = value.filterType || '';
  const filters = (value.filters as QueryFilter[]) || [];
  const mode = value.mode || 'list';
  const groupBy = value.groupBy || '';

  const update = (partial: Partial<QueryView>) => {
    if (node) set({ ...node, ...partial });
  };

  const hasActiveFilters = !!filterType || filters.some(f => f.field && f.value);
  const children = useChildren(source) ?? [];
  const fields = useMemo(() => collectFields(children), [children]);

  const childTypes = useMemo(() => {
    const types = new Set<string>();
    for (const c of children) {
      for (const [, comp] of getComponents(c)) types.add(String(comp.$type));
    }
    return [...types].sort();
  }, [children]);

  const filtered = useMemo(() => {
    if (!hasActiveFilters) return [];
    let result = [...children];
    if (filterType) result = result.filter(c =>
      getComponents(c).some(([, comp]) => comp.$type === filterType),
    );
    if (filters.length) result = result.filter(c => matchFilters(c, filters));
    return result.slice(0, 50);
  }, [children, filterType, filters, hasActiveFilters]);

  const updateFilter = (i: number, patch: Partial<QueryFilter>) => {
    const next = filters.map((f, j) => j === i ? { ...f, ...patch } : f);
    update({ filters: next });
  };

  const addFilter = () => update({ filters: [...filters, { field: '', value: '' }] });
  const removeFilter = (i: number) => update({ filters: filters.filter((_, j) => j !== i) });

  return (
    <div className="rounded-lg border border-dashed border-emerald-600/40 overflow-hidden bg-card">
      {/* Edit panel */}
      <div className="px-3 py-2 border-b border-border bg-emerald-950/20 flex flex-col gap-1.5">
        {/* Source */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground w-12 shrink-0">source</span>
          <input className={inputCls} value={source} onChange={e => update({ source: e.target.value })} placeholder="/path" />
        </div>

        {/* Type filter */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground w-12 shrink-0">type</span>
          {childTypes.length > 0 ? (
            <select className={selectCls + ' flex-1'} value={filterType} onChange={e => update({ filterType: e.target.value })}>
              <option value="">all types</option>
              {childTypes.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          ) : (
            <input className={inputCls} value={filterType} onChange={e => update({ filterType: e.target.value })} placeholder="e.g. doc.page" />
          )}
        </div>

        {/* Mode */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground w-12 shrink-0">mode</span>
          <div className="flex items-center gap-0.5">
            {MODES.map(m => (
              <button
                key={m.id}
                onClick={() => update({ mode: m.id })}
                title={m.label}
                className={`p-1 rounded transition-colors ${mode === m.id ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {m.icon}
              </button>
            ))}
          </div>
        </div>

        {/* Group by */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground w-12 shrink-0">group</span>
          {fields.length > 0 ? (
            <select className={selectCls + ' flex-1'} value={groupBy} onChange={e => update({ groupBy: e.target.value })}>
              <option value="">none</option>
              {fields.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          ) : (
            <input className={inputCls} value={groupBy} onChange={e => update({ groupBy: e.target.value })} placeholder="field name" />
          )}
        </div>

        {/* Filters */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground w-12 shrink-0">filters</span>
            <button onClick={addFilter} className="text-[10px] text-emerald-400 hover:text-emerald-300 flex items-center gap-0.5 transition-colors">
              <Plus size={10} /> add
            </button>
          </div>
          {filters.map((fl, i) => (
            <div key={i} className="flex items-center gap-1 pl-14">
              {fields.length > 0 ? (
                <select className={selectCls + ' w-28 shrink-0'} value={fl.field} onChange={e => updateFilter(i, { field: e.target.value })}>
                  <option value="">field…</option>
                  {fields.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
              ) : (
                <input className={inputCls + ' max-w-24 shrink-0'} value={fl.field} onChange={e => updateFilter(i, { field: e.target.value })} placeholder="field" />
              )}
              <input className={inputCls} value={fl.value} onChange={e => updateFilter(i, { value: e.target.value })} placeholder="contains…" />
              <button onClick={() => removeFilter(i)} className="text-muted-foreground/40 hover:text-destructive transition-colors shrink-0">
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Results */}
      {!hasActiveFilters ? (
        <div className="px-4 py-6 text-center text-xs text-muted-foreground">
          Set a type or add filters to display results
        </div>
      ) : filtered.length === 0 ? (
        <div className="px-4 py-6 text-center text-xs text-muted-foreground">
          No matches
        </div>
      ) : mode === 'table' ? (
        <TableView items={filtered} groupBy={groupBy} />
      ) : mode === 'kanban' ? (
        <KanbanView items={filtered} groupBy={groupBy} />
      ) : (
        <ListView items={filtered} />
      )}

      {filtered.length > 0 && (
        <div className="px-3 py-1.5 border-t border-border text-[10px] text-muted-foreground text-right">
          {filtered.length}{filtered.length === 50 ? '+' : ''} results
        </div>
      )}
    </div>
  );
};

register('t.query', 'react', QueryViewComponent);
register('t.query', 'react:edit', QueryEditView);
