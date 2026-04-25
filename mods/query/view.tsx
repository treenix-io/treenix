import type { NodeData } from '@treenity/core';
import { register } from '@treenity/core';
import { Render, RenderContext, type View } from '@treenity/react';
import { useChildren, useNavigate } from '@treenity/react/hooks';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@treenity/react/ui/table';
import { List, Plus, Rows3, Table2, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useChildTypes, useFiltered } from './hooks';
import { type QueryFilter, QueryView } from './types';

type Mode = QueryView['mode'];

const MODES: { id: Mode; icon: ReactNode; label: string }[] = [
  { id: 'list', icon: <List size={14} />, label: 'List' },
  { id: 'table', icon: <Table2 size={14} />, label: 'Table' },
  { id: 'kanban', icon: <Rows3 size={14} />, label: 'Kanban' },
];

function f(node: NodeData, key: string): string {
  const v = node[key];
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
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
    const key = f(node, groupBy) || 'empty';
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
          <Render key={child.$path} value={child} />
        ))}
      </div>
    </RenderContext>
  );
}

function MiniTable({ items, fields, title, count }: { items: NodeData[]; fields: string[]; title?: string; count?: number }) {
  const navigate = useNavigate();

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      {title && (
        <div className="px-3 py-1.5 bg-muted/30 border-b border-border">
          <span className="text-xs font-semibold text-foreground">{title}</span>
          <span className="ml-2 text-[10px] text-muted-foreground">{count}</span>
        </div>
      )}
      <Table className="text-xs">
        <TableHeader>
          <TableRow className="bg-muted/20">
            <TableHead className="h-7 px-3 text-[11px]">name</TableHead>
            {fields.map(k => (
              <TableHead key={k} className="h-7 px-3 text-[11px]">{k}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map(node => (
            <TableRow
              key={node.$path}
              onClick={() => navigate(node.$path)}
              className="cursor-pointer"
            >
              <TableCell className="px-3 py-1.5 font-mono text-emerald-400/80">
                {node.$path.split('/').pop()}
              </TableCell>
              {fields.map(k => (
                <TableCell key={k} className="px-3 py-1.5 text-foreground/80 max-w-48 truncate">
                  {f(node, k) || <span className="text-muted-foreground/40">&mdash;</span>}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function TableView({ items, groupBy }: { items: NodeData[]; groupBy: string }) {
  const fields = useMemo(() => collectFields(items), [items]);
  const groups = useMemo(() => groupBy ? [...groupItems(items, groupBy).entries()] : null, [items, groupBy]);

  if (groups) {
    return (
      <div className="flex flex-col gap-2 p-3">
        {groups.map(([group, nodes]) => (
          <MiniTable key={group} items={nodes} fields={fields} title={group} count={nodes.length} />
        ))}
      </div>
    );
  }

  return <MiniTable items={items} fields={fields} />;
}

function KanbanView({ items, groupBy }: { items: NodeData[]; groupBy: string }) {
  const groups = useMemo(() => [...groupItems(items, groupBy).entries()], [items, groupBy]);

  return (
    <div className="flex flex-col gap-2 p-3">
      {groups.map(([group, nodes]) => (
        <div key={group} className="rounded-lg border border-border bg-muted/20">
          <div className="px-3 py-2 border-b border-border">
            <span className="text-xs font-semibold text-foreground">{group}</span>
            <span className="ml-2 text-[10px] text-muted-foreground">{nodes.length}</span>
          </div>
          <RenderContext name="react:list">
            <div className="flex flex-col gap-1.5 p-2">
              {nodes.map(child => (
                <Render key={child.$path} value={child} />
              ))}
            </div>
          </RenderContext>
        </div>
      ))}
    </div>
  );
}

function Results({ items, mode, groupBy }: { items: NodeData[]; mode: Mode; groupBy: string }) {
  if (items.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-xs text-muted-foreground">
        No matches
      </div>
    );
  }

  return (
    <>
      {mode === 'table' ? (
        <TableView items={items} groupBy={groupBy} />
      ) : mode === 'kanban' ? (
        <KanbanView items={items} groupBy={groupBy} />
      ) : (
        <ListView items={items} />
      )}
      <div className="px-3 py-1.5 border-t border-border text-[10px] text-muted-foreground text-right">
        {items.length} results
      </div>
    </>
  );
}

// ── Main view ──

const QueryViewComponent: View<QueryView> = ({ value, onChange }) => {
  const source = value.source || '/';
  const typeFilter = value.typeFilter || '';
  const filters = value.filters || [];
  const groupBy = value.groupBy || '';

  const [localMode, setLocalMode] = useState<Mode>(value.mode || 'list');
  const mode = onChange ? (value.mode || 'list') : localMode;

  const setMode = (m: Mode) => {
    if (onChange) onChange({ mode: m });
    else setLocalMode(m);
  };

  const { data: children }  = useChildren(source, { limit: 50, watchNew: true, watch: true });
  const filtered = useFiltered(children, typeFilter, filters);

  return (
    <div className="rounded-lg border border-border overflow-hidden bg-card">
      <div className="flex items-center gap-1 px-3 py-2 border-b border-border">
        <span className="text-xs text-muted-foreground font-mono mr-2">{source}</span>
        {typeFilter && <span className="px-1.5 py-0.5 rounded bg-accent text-accent-foreground text-[10px]">{typeFilter}</span>}
        {filters.length > 0 && <span className="text-[10px] text-emerald-400">{filters.length} filter{filters.length > 1 ? 's' : ''}</span>}

        <div className="ml-auto flex items-center gap-0.5">
          {MODES.map(m => (
            <button
              key={m.id}
              onClick={() => setMode(m.id)}
              title={m.label}
              className={`p-1.5 rounded transition-colors ${mode === m.id ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {m.icon}
            </button>
          ))}
        </div>
      </div>

      <Results items={filtered} mode={mode} groupBy={groupBy} />
    </div>
  );
};

// ── Edit view ──

const inputCls = 'flex-1 bg-muted/30 rounded px-2 py-1 text-xs text-foreground border border-border outline-none focus:border-emerald-500 min-w-0';
const selectCls = 'bg-muted/30 rounded px-2 py-1 text-xs text-foreground border border-border outline-none focus:border-emerald-500 min-w-0 cursor-pointer';

const QueryEditView: View<QueryView> = ({ value, onChange }) => {
  const source = value.source || '/';
  const typeFilter = value.typeFilter || '';
  const filters = value.filters || [];
  const mode = value.mode || 'list';
  const groupBy = value.groupBy || '';

  const { data: children } = useChildren(source, { limit: 50 });
  const fields = useMemo(() => collectFields(children), [children]);
  const childTypes = useChildTypes(children);
  const filtered = useFiltered(children, typeFilter, filters);

  const updateFilter = (i: number, patch: Partial<QueryFilter>) => {
    const next = filters.map((fl, j) => j === i ? { ...fl, ...patch } : fl);
    onChange?.({ filters: next });
  };

  const addFilter = () => onChange?.({ filters: [...filters, { field: '', value: '' }] });
  const removeFilter = (i: number) => onChange?.({ filters: filters.filter((_, j) => j !== i) });

  return (
    <div className="rounded-lg border border-dashed border-emerald-600/40 overflow-hidden bg-card">
      <div className="px-3 py-2 border-b border-border bg-emerald-950/20 flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground w-12 shrink-0">source</span>
          <input className={inputCls} value={source} onChange={e => onChange?.({ source: e.target.value })} placeholder="/path" />
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground w-12 shrink-0">type</span>
          {childTypes.length > 0 ? (
            <select className={selectCls + ' flex-1'} value={typeFilter} onChange={e => onChange?.({ typeFilter: e.target.value })}>
              <option value="">all types</option>
              {childTypes.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          ) : (
            <input className={inputCls} value={typeFilter} onChange={e => onChange?.({ typeFilter: e.target.value })} placeholder="e.g. doc.page" />
          )}
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground w-12 shrink-0">mode</span>
          <div className="flex items-center gap-0.5">
            {MODES.map(m => (
              <button
                key={m.id}
                onClick={() => onChange?.({ mode: m.id })}
                title={m.label}
                className={`p-1 rounded transition-colors ${mode === m.id ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {m.icon}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground w-12 shrink-0">group</span>
          {fields.length > 0 ? (
            <select className={selectCls + ' flex-1'} value={groupBy} onChange={e => onChange?.({ groupBy: e.target.value })}>
              <option value="">none</option>
              {fields.map(fl => <option key={fl} value={fl}>{fl}</option>)}
            </select>
          ) : (
            <input className={inputCls} value={groupBy} onChange={e => onChange?.({ groupBy: e.target.value })} placeholder="field name" />
          )}
        </div>

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
                  {fields.map(fld => <option key={fld} value={fld}>{fld}</option>)}
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

      <Results items={filtered} mode={mode} groupBy={groupBy} />
    </div>
  );
};

register('t.query', 'react', QueryViewComponent);
register('t.query', 'react:edit', QueryEditView);
