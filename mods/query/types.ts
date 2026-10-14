import { declareClientType } from '@treenx/core/comp/client-declaration';
import { declareOpenModule } from '@treenx/core/kernel/module-declaration';

export type QueryFilter = { field: string; value: string };

/** Tree-backed virtual view configuration for filtering and grouping child nodes. */
export class QueryView {
  /** @title Source path */
  source = '/';
  /** @title Type filter */
  typeFilter = '';
  /** @title Filters @format hidden */
  filters: QueryFilter[] = [];
  /** @title Render mode */
  mode: 'list' | 'table' | 'kanban' = 'list';
  /** @title Group by field */
  groupBy = 'status';
}

const declaredTQuery = declareClientType('t.query', QueryView);

export const clientModules = [declareOpenModule('@treenx/mods/query/types', [], [declaredTQuery])];
