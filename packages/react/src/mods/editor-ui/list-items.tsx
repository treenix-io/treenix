import { declareClientModule } from '#context/client-registry';
import type { PresentationNode } from '#tree/presentation';
// Default content-only views for react:list / react:card / react:icon, plus the observer-side
// chrome wrapper <RenderChildren>. Convention: items render CONTENT only (no border, no click,
// no fixed width) — chrome and navigation are the observer's responsibility.

import { NodeProvider,Render,RenderContext } from '#context';
import { useClientRegistry } from '#context/client-registry-context';
import { componentEntries } from '@treenx/core/kernel/migrate';
import { useNavigate } from '#navigate';
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

function DirListItem({ value }: { value: PresentationNode }) {
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

function DefaultListItem({ value }: { value: PresentationNode }) {
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

function DefaultCard({ value }: { value: PresentationNode }) {
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

function DefaultIcon({ value }: { value: PresentationNode }) {
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

function targetPath(item: PresentationNode): string {
  return ((item as { $ref?: string }).$ref) ?? item.$path;
}

/** Compose each component's own list view; explicit wrappers receive the combined content. */
export function RenderListItem({ value }: { value: PresentationNode }) {
  const registry = useClientRegistry();
  const components = componentEntries(value).slice(1).map(([name, component]) => ({
    name,
    component,
    view: registry.exact(component.$type, 'react:list'),
  }));

  let content: ReactNode = (
    <>
      <Render value={value} />
      {components.map(({ name, component, view }) =>
        view !== null && view.meta?.wrap !== true ? <Render key={name} value={component} /> : null,
      )}
    </>
  );

  for (const { name, component, view } of components) {
    if (view?.meta?.wrap === true) content = <Render key={name} value={component}>{content}</Render>;
  }

  return <NodeProvider value={value}><RenderContext name="react:list">{content}</RenderContext></NodeProvider>;
}

export function RenderChildren({
  items,
  ctx,
  empty,
}: {
  items: PresentationNode[];
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
              {ctx === 'list' ? <RenderListItem value={item} /> : <Render value={item} />}
            </div>
          ),
        )}
      </div>
    </RenderContext>
  );
}

// Single-item rendering with the same chrome convention.
export function RenderItem({ value, ctx }: { value: PresentationNode; ctx: ChildCtx }) {
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
        {ctx === 'list' ? <RenderListItem value={value} /> : <Render value={value} />}
      </div>
    </RenderContext>
  );
}

export default declareClientModule('@treenx/react/editor-ui/list-items', [
  { type: 'dir', context: 'react:list', handler: DirListItem },
  { type: 'default', context: 'react:list', handler: DefaultListItem },
  { type: 'default', context: 'react:card', handler: DefaultCard },
  { type: 'default', context: 'react:icon', handler: DefaultIcon }
]);
