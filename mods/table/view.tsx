import { type ComponentData, isComponent, type NodeData, register } from '@treenity/core';
import type { TypeSchema } from '@treenity/core/schema/types';
import { Render, RenderContext, type ViewCtx } from '@treenity/react';
import { useChildren } from '@treenity/react';
import { useSchema } from '@treenity/react/schema-loader';
import { Button } from '@treenity/react/ui/button';
import { Input } from '@treenity/react/ui/input';
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@treenity/react/ui/pagination';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@treenity/react/ui/table';
import { useMemo } from 'react';
import type { ColumnConfig, UITable } from './types';
import { useDebouncedSync } from './use-debounced-sync';

// ── Helpers ──

function resolveField(child: NodeData, field: string): Record<string, unknown> {
  if (!field) return child;
  const val = (child as any)[field];
  if (val && typeof val === 'object') return val;
  return child;
}

function resolveDisplayType(field: string, comp: Record<string, unknown>): string {
  if (!field) return (comp as any).$type ?? '';
  const val = comp as any;
  return val.$type ?? '';
}

function cellValue(row: Record<string, unknown>, field: string): unknown {
  return row[field];
}

function formatCell(val: unknown): string {
  if (val == null || val === '') return '—';
  if (typeof val === 'boolean') return val ? 'Yes' : 'No';
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

function CellValue({ value }: { value: unknown }) {
  if (isComponent(value)) return <Render value={value} />;
  return <>{formatCell(value)}</>;
}

function buildColumnsFromSchema(schema: TypeSchema): ColumnConfig[] {
  if (!schema.properties) return [];
  return Object.entries(schema.properties)
    .filter(([k]) => !k.startsWith('$'))
    .map(([field, prop]) => ({
      field,
      label: (prop as any).title || field,
      visible: true,
    }));
}

function buildColumnsFromData(rows: Record<string, unknown>[]): ColumnConfig[] {
  const keys = new Set<string>();
  for (const row of rows.slice(0, 20)) {
    for (const k of Object.keys(row)) {
      if (!k.startsWith('$')) keys.add(k);
    }
  }
  return [...keys].map(field => ({ field, label: field, visible: true }));
}

// ── Table View ──

const TABLE_DEFAULTS: UITable = { displayType: '', field: '', pageSize: 25, page: 0, sort: '', sortDir: 'asc', columns: {} };

function TableView({ value, ctx }: { value: ComponentData; ctx?: ViewCtx | null }) {
  if (!ctx?.node) throw new Error('TableView: no node context');
  const node = ctx.node;
  const componentKey = useMemo(() => {
    for (const [k, v] of Object.entries(node)) {
      if (v === value) return k;
    }
    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === 'object' && (v as any).$type === 'ui.table') return k;
    }
    return 'table';
  }, [node, value]);

  const [state, update] = useDebouncedSync<UITable>(node, componentKey, TABLE_DEFAULTS);
  const { data: children } = useChildren(node.$path, { watch: true, limit: 1000 });

  // Collect unique types from children (resolved through field)
  const { typeMap, types } = useMemo(() => {
    const map = new Map<string, NodeData[]>();
    for (const child of children) {
      const resolved = resolveField(child, state.field);
      const dt = resolveDisplayType(state.field, resolved);
      if (!dt) continue;
      const arr = map.get(dt) ?? [];
      arr.push(child);
      map.set(dt, arr);
    }
    return { typeMap: map, types: [...map.keys()] };
  }, [children, state.field]);

  // Active display type
  const activeType = state.displayType && types.includes(state.displayType)
    ? state.displayType
    : types[0] ?? '';

  // Rows for active type
  const rawRows = useMemo(() => {
    const matched = typeMap.get(activeType) ?? [];
    return matched.map(child => ({
      $path: child.$path,
      data: resolveField(child, state.field),
    }));
  }, [typeMap, activeType, state.field]);

  // Columns: from saved config, schema, or data
  const schema = useSchema(activeType);
  const columns = useMemo(() => {
    const saved = state.columns[activeType];
    if (saved?.length) return saved.filter(c => c.visible !== false);

    if (schema) return buildColumnsFromSchema(schema);
    if (rawRows.length) return buildColumnsFromData(rawRows.map(r => r.data));
    return [];
  }, [state.columns, activeType, schema, rawRows]);

  // Filter
  const filtered = useMemo(() => {
    return rawRows.filter(row => {
      for (const col of columns) {
        if (!col.filter) continue;
        const val = formatCell(cellValue(row.data, col.field));
        if (!val.toLowerCase().includes(col.filter.toLowerCase())) return false;
      }
      return true;
    });
  }, [rawRows, columns]);

  // Sort
  const sorted = useMemo(() => {
    if (!state.sort) return filtered;
    const dir = state.sortDir === 'desc' ? -1 : 1;
    return [...filtered].sort((a, b) => {
      const va = cellValue(a.data, state.sort);
      const vb = cellValue(b.data, state.sort);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }, [filtered, state.sort, state.sortDir]);

  // Paginate
  const totalPages = Math.max(1, Math.ceil(sorted.length / (state.pageSize || 25)));
  const page = Math.min(state.page || 0, totalPages - 1);
  const pageRows = sorted.slice(page * state.pageSize, (page + 1) * state.pageSize);

  // Handlers
  const toggleSort = (field: string) => {
    if (state.sort === field) {
      update({ sortDir: state.sortDir === 'asc' ? 'desc' : 'asc' } as Partial<UITable>);
    } else {
      update({ sort: field, sortDir: 'asc' } as Partial<UITable>);
    }
  };

  const setColumnFilter = (field: string, filter: string) => {
    const current = (state.columns ?? {})[activeType] ?? columns;
    const next = current.map(c => c.field === field ? { ...c, filter } : c);
    update({ columns: { ...(state.columns ?? {}), [activeType]: next }, page: 0 } as Partial<UITable>);
  };

  const setPage = (p: number) => update({ page: p } as Partial<UITable>);

  const setDisplayType = (dt: string) => {
    update({ displayType: dt, page: 0 } as Partial<UITable>);
  };

  return (
    <div className="flex flex-col gap-2 text-sm">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        {types.length > 1 && types.map(t => (
          <Button
            key={t}
            variant={t === activeType ? 'default' : 'outline'}
            size="sm"
            className="h-6 text-xs"
            onClick={() => setDisplayType(t)}
          >
            {t} <span className="ml-1 text-muted-foreground">({typeMap.get(t)?.length ?? 0})</span>
          </Button>
        ))}

        <span className="ml-auto text-xs text-muted-foreground">
          {sorted.length} row{sorted.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Table */}
      {columns.length > 0 ? (
        <RenderContext name="react:compact:cell">
          <div className="rounded-md border border-border">
            <Table className="text-xs">
              <TableHeader>
                <TableRow>
                  {columns.map(col => (
                    <TableHead
                      key={col.field}
                      className="h-8 cursor-pointer select-none text-xs hover:text-foreground"
                      onClick={() => toggleSort(col.field)}
                    >
                      <span>{col.label ?? col.field}</span>
                      {state.sort === col.field && (
                        <span className="ml-1 text-primary">
                          {state.sortDir === 'asc' ? '↑' : '↓'}
                        </span>
                      )}
                    </TableHead>
                  ))}
                </TableRow>
                <TableRow className="hover:bg-transparent">
                  {columns.map(col => (
                    <TableHead key={col.field} className="h-auto px-1 py-1">
                      <Input
                        type="text"
                        placeholder="filter"
                        className="h-6 text-xs"
                        value={col.filter ?? ''}
                        onChange={e => setColumnFilter(col.field, e.target.value)}
                      />
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageRows.map(row => (
                  <TableRow key={row.$path}>
                    {columns.map(col => (
                      <TableCell key={col.field} className="max-w-[300px] truncate">
                        <CellValue value={cellValue(row.data, col.field)} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
                {pageRows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={columns.length} className="py-4 text-center text-muted-foreground">
                      No data
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </RenderContext>
      ) : (
        <div className="py-4 text-center text-muted-foreground">No children or schema</div>
      )}

      {totalPages > 1 && (
        <TablePagination page={page} totalPages={totalPages} onPageChange={setPage} />
      )}
    </div>
  );
}

// ── Pagination ──

function pageRange(current: number, total: number): (number | 'ellipsis')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i);

  const pages: (number | 'ellipsis')[] = [0];

  if (current > 2) pages.push('ellipsis');

  const start = Math.max(1, current - 1);
  const end = Math.min(total - 2, current + 1);
  for (let i = start; i <= end; i++) pages.push(i);

  if (current < total - 3) pages.push('ellipsis');

  pages.push(total - 1);
  return pages;
}

function TablePagination({ page, totalPages, onPageChange }: {
  page: number;
  totalPages: number;
  onPageChange: (p: number) => void;
}) {
  const pages = pageRange(page, totalPages);

  return (
    <Pagination className="justify-start">
      <PaginationContent className="gap-0.5">
        <PaginationItem>
          <PaginationPrevious
            className="h-7 cursor-pointer text-xs [&>span]:hidden"
            onClick={() => page > 0 && onPageChange(page - 1)}
            aria-disabled={page === 0}
            tabIndex={page === 0 ? -1 : undefined}
          />
        </PaginationItem>

        {pages.map((p, i) =>
          p === 'ellipsis' ? (
            <PaginationItem key={`e${i}`}>
              <PaginationEllipsis className="size-7" />
            </PaginationItem>
          ) : (
            <PaginationItem key={p}>
              <PaginationLink
                className="h-7 w-7 cursor-pointer text-xs"
                isActive={p === page}
                onClick={() => onPageChange(p)}
              >
                {p + 1}
              </PaginationLink>
            </PaginationItem>
          ),
        )}

        <PaginationItem>
          <PaginationNext
            className="h-7 cursor-pointer text-xs [&>span]:hidden"
            onClick={() => page < totalPages - 1 && onPageChange(page + 1)}
            aria-disabled={page >= totalPages - 1}
            tabIndex={page >= totalPages - 1 ? -1 : undefined}
          />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}

register('ui.table', 'react', TableView as any);
