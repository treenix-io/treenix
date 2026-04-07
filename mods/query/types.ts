import { registerType } from '@treenity/core/comp';

export type QueryFilter = { field: string; value: string };

export class QueryView {
  /** @title Source path */
  source = '/';
  /** @title Type filter */
  filterType = '';
  /** @title Filters @format hidden */
  filters: QueryFilter[] = [];
  /** @title Render mode */
  mode: 'list' | 'table' | 'kanban' = 'list';
  /** @title Group by field (for kanban mode) */
  groupBy = 'status';
}

registerType('t.query', QueryView);
