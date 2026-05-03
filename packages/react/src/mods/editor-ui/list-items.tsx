// Default content-only views for react:list / react:card / react:icon, plus the observer-side
// chrome wrapper <RenderChildren>. Convention: items render CONTENT only (no border, no click,
// no fixed width) — chrome and navigation are the observer's responsibility.

import { Render, RenderContext } from '#context';
import { useNavigate } from '#navigate';
import type { NodeData } from '@treenx/core';
import { register } from '@treenx/core';
import type { ReactNode } from 'react';

const TYPE_ICONS: Record<string, string> = {
  root: '/',
  folder: 'D',
  page: 'P',
  bot: 'B',
  'type-registry': 'T',
  'mount-point': 'M',
  type: 'S',
  user: 'U',
  shop: 'S',
  config: 'C',
};

function typeIcon(type: string): string {
  return TYPE_ICONS[type] ?? type.charAt(0).toUpperCase();
}

export function pathName(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1) || '/';
}

// ── Item content (no chrome) ──

function DirListItem({ value }: { value: NodeData }) {
  const meta = value.metadata as { $type: string; title?: string; description?: string } | undefined;
  return (
    <>
      <span className="flex h-6 w-6 items-center justify-center rounded bg-secondary text-[12px]">
        &#128193;
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] font-medium text-foreground">
          {meta?.title ?? pathName(value.$path)}
        </span>
        <span className="truncate text-[11px] text-muted-foreground">
          {meta?.description ?? 'dir'}
        </span>
      </div>
    </>
  );
}
register('dir', 'react:list', DirListItem as any);

function DefaultListItem({ value }: { value: NodeData }) {
  return (
    <>
      <span className="flex h-6 w-6 items-center justify-center rounded bg-secondary text-[11px] font-semibold text-muted-foreground">
        {typeIcon(value.$type)}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] font-medium text-foreground">
          {pathName(value.$path)}
        </span>
        <span className="truncate text-[11px] text-muted-foreground">{value.$type}</span>
      </div>
    </>
  );
}
register('default', 'react:list', DefaultListItem as any);

function DefaultCard({ value }: { value: NodeData }) {
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded bg-secondary text-[11px] font-semibold text-muted-foreground">
          {typeIcon(value.$type)}
        </span>
        <span className="flex-1 truncate text-[13px] font-medium text-foreground">
          {pathName(value.$path)}
        </span>
      </div>
      <span className="truncate text-[11px] text-muted-foreground">{value.$type}</span>
    </>
  );
}
register('default', 'react:card', DefaultCard as any);

function DefaultIcon({ value }: { value: NodeData }) {
  return (
    <>
      <span className="flex h-10 w-10 items-center justify-center rounded-md bg-secondary text-[14px] font-semibold text-muted-foreground">
        {typeIcon(value.$type)}
      </span>
      <span className="line-clamp-2 text-center text-[10px] leading-tight text-foreground">
        {pathName(value.$path)}
      </span>
    </>
  );
}
register('default', 'react:icon', DefaultIcon as any);

// ── Observer-side chrome ──

export type ChildCtx = 'list' | 'card' | 'icon' | 'react';

const CTX_NAME: Record<ChildCtx, string> = {
  list: 'react:list',
  card: 'react:card',
  icon: 'react:icon',
  react: 'react',
};

const LAYOUT: Record<ChildCtx, string> = {
  list: 'flex flex-col gap-0.5',
  card: 'flex flex-wrap gap-3',
  icon: 'grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(80px,1fr))]',
  react: 'flex flex-col gap-4',
};

const ITEM_CHROME: Record<ChildCtx, string> = {
  list: 'flex items-center gap-3 cursor-pointer rounded-md px-3 py-2 hover:bg-accent/50 transition-colors',
  card: 'flex w-[200px] flex-col gap-1 cursor-pointer rounded-md border border-border bg-card px-3 py-2 hover:bg-accent/50 transition-colors',
  icon: 'flex flex-col items-center gap-1.5 cursor-pointer rounded-md p-2 hover:bg-accent/50 transition-colors',
  react: '',
};

function targetPath(item: NodeData): string {
  return ((item as { $ref?: string }).$ref) ?? item.$path;
}

export function RenderChildren({
  items,
  ctx,
  empty,
}: {
  items: NodeData[];
  ctx: ChildCtx;
  empty?: ReactNode;
}) {
  const navigate = useNavigate();
  if (items.length === 0) return empty ?? null;

  return (
    <RenderContext name={CTX_NAME[ctx]}>
      <div className={LAYOUT[ctx]}>
        {items.map((item) =>
          ctx === 'react' ? (
            <Render key={item.$path} value={item} />
          ) : (
            <div
              key={item.$path}
              onClick={() => navigate(targetPath(item))}
              className={ITEM_CHROME[ctx]}
            >
              <Render value={item} />
            </div>
          ),
        )}
      </div>
    </RenderContext>
  );
}

// Single-item rendering with the same chrome convention.
export function RenderItem({ value, ctx }: { value: NodeData; ctx: ChildCtx }) {
  const navigate = useNavigate();
  if (ctx === 'react') {
    return (
      <RenderContext name="react">
        <Render value={value} />
      </RenderContext>
    );
  }
  return (
    <RenderContext name={CTX_NAME[ctx]}>
      <div onClick={() => navigate(targetPath(value))} className={ITEM_CHROME[ctx]}>
        <Render value={value} />
      </div>
    </RenderContext>
  );
}
