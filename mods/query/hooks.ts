import type { NodeData } from '@treenity/core';
import { getComponents } from '@treenity/core';
import { useMemo } from 'react';
import { type QueryFilter } from './types';

function f(node: NodeData, key: string): string {
  const v = node[key];
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function matchFilters(node: NodeData, filters: QueryFilter[]): boolean {
  return filters.every(({ field, value }) => {
    if (!field || !value) return true;
    return f(node, field).toLowerCase().includes(value.toLowerCase());
  });
}

export function useFiltered(children: NodeData[], typeFilter: string, filters: QueryFilter[]) {
  return useMemo(() => {
    let result = children;
    if (typeFilter) result = result.filter(c =>
      getComponents(c).some(([, comp]) => comp.$type === typeFilter),
    );
    if (filters.length) result = result.filter(c => matchFilters(c, filters));
    return result;
  }, [children, typeFilter, filters]);
}

export function useChildTypes(children: NodeData[]) {
  return useMemo(() => {
    const types = new Set<string>();
    for (const c of children) {
      for (const [, comp] of getComponents(c)) types.add(comp.$type);
    }
    return [...types].sort();
  }, [children]);
}
