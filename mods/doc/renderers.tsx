// Lazy loader: registers doc.page view but defers tiptap import until render

import { register } from '@treenx/core';
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

export function registerDocViews() {
  register('doc.page', 'react', ({ onChange, ...props }) => DocPageView(props));
  register('doc.page', 'react:edit', DocPageView);
}
