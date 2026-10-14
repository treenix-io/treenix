import { declareClientType } from '@treenx/core/comp/client-declaration';
import { declareOpenModule } from '@treenx/core/kernel/module-declaration';

export type ColumnConfig = {
  field: string;
  label?: string;
  visible?: boolean;
  width?: number;
  filter?: string;
};

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

const declaredUiTable = declareClientType('ui.table', UITable);

export const clientModules = [declareOpenModule('@treenx/mods/table/types', [], [declaredUiTable])];
