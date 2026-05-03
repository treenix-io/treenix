// Lazy loader: registers doc.page view but defers tiptap import until render

import { register, type NodeData } from '@treenx/core';
import { lazy, Suspense } from 'react';

const DocPageViewLazy = lazy(() =>
  import('./renderers-impl').then((m) => ({ default: m.DocPageView })),
);

type BlockProps = { value: any; onChange?: (data: any) => void };

function DocPageView(props: BlockProps) {
  return (
    <Suspense fallback={<div className="max-w-3xl mx-auto py-6 px-4 min-h-[300px] animate-pulse" />}>
      <DocPageViewLazy {...props} />
    </Suspense>
  );
}

// Extract first ~140 chars of plain text from a Tiptap doc, without loading tiptap.
function extractSnippet(node: unknown, max = 140): string {
  if (!node || typeof node !== 'object') return '';
  const out: string[] = [];
  let len = 0;
  const walk = (n: any): boolean => {
    if (!n || typeof n !== 'object') return false;
    if (typeof n.text === 'string') {
      out.push(n.text);
      len += n.text.length;
      return len >= max;
    }
    if (Array.isArray(n.content)) {
      for (const c of n.content) {
        if (walk(c)) return true;
        if (n.type === 'paragraph' || n.type === 'heading') {
          out.push(' ');
          len += 1;
        }
      }
    }
    return len >= max;
  };
  walk(node);
  const text = out.join('').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max).trimEnd() + '…' : text;
}

function pathName(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1) || '/';
}

function DocPageCard({ value }: { value: NodeData }) {
  const data = value as { title?: unknown; content?: unknown };
  const title = (typeof data.title === 'string' && data.title.trim()) || pathName(value.$path);
  const snippet = extractSnippet(data.content);

  return (
    <>
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded bg-secondary text-[12px] font-semibold text-muted-foreground">
          ¶
        </span>
        <span className="flex-1 truncate text-[13px] font-medium text-foreground">{title}</span>
      </div>
      {snippet ? (
        <div className="line-clamp-3 text-[11px] leading-snug text-muted-foreground">
          {snippet}
        </div>
      ) : (
        <div className="text-[11px] italic text-muted-foreground">Empty</div>
      )}
    </>
  );
}

export function registerDocViews() {
  register('doc.page', 'react', ({ onChange, ...props }) => DocPageView(props));
  register('doc.page', 'react:edit', DocPageView);
  register('doc.page', 'react:card', DocPageCard as any);
}
