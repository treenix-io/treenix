import type { LayoutRow } from './types';

let _counter = 0;
const rid = () => `r${Date.now().toString(36)}${(_counter++).toString(36)}`;

export type TemplateDef = {
  name: string;
  label: string;
  apply: (refs: string[]) => LayoutRow[];
};

export const templates: TemplateDef[] = [
  {
    name: 'stack',
    label: 'Stack (single column)',
    apply: (refs) => refs.map((ref) => ({ id: rid(), items: [{ ref }] })),
  },
  {
    name: 'sidebar-main',
    label: 'Sidebar + Main',
    apply: (refs) => {
      const [first, ...rest] = refs;
      if (!first) return [];
      const firstRow: LayoutRow = {
        id: rid(),
        items: [{ ref: first }, ...(rest[0] ? [{ ref: rest[0] }] : [])],
        grid: '280px 1fr',
      };
      return [firstRow, ...rest.slice(1).map((ref) => ({ id: rid(), items: [{ ref }] }))];
    },
  },
  {
    name: 'two-column',
    label: 'Two Columns',
    apply: (refs) => {
      const rows: LayoutRow[] = [];
      for (let i = 0; i < refs.length; i += 2) {
        const pair = [{ ref: refs[i] }];
        if (refs[i + 1]) pair.push({ ref: refs[i + 1] });
        rows.push({ id: rid(), items: pair, grid: '1fr 1fr' });
      }
      return rows;
    },
  },
  {
    name: 'dashboard',
    label: 'Hero + Grid',
    apply: (refs) => {
      const [hero, ...rest] = refs;
      const rows: LayoutRow[] = hero ? [{ id: rid(), items: [{ ref: hero }] }] : [];
      for (let i = 0; i < rest.length; i += 3) {
        const chunk = rest.slice(i, i + 3).map((ref) => ({ ref }));
        rows.push({ id: rid(), items: chunk, grid: 'repeat(3, 1fr)' });
      }
      return rows;
    },
  },
];
