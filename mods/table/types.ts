import { registerType } from '@treenx/core/comp';

export type ColumnConfig = {
  field: string
  label?: string
  visible?: boolean
  width?: number
  filter?: string
}

/** Table view — paginates children, auto-columns from schema, per-column filters */
export class UITable {
  displayType = '';
  field = '';
  pageSize = 25;
  page = 0;
  sort = '';
  sortDir: 'asc' | 'desc' = 'asc';
  columns: Record<string, ColumnConfig[]> = {};
}

registerType('ui.table', UITable);
