import 'reflect-metadata';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { enablePatches } from 'immer';
import { type ReactNode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { App } from './App';
import { AuthProvider } from './auth-context';
import '#tree/load-client';
import { hydrateFromServerSnapshot } from '#tree/cache';
import { createClientTreeSource } from '#tree/client-tree-source';
import { TreeSourceProvider } from '#tree/tree-source-context';
import { Toaster } from '#components/ui/sonner';
import '../root.css';

enablePatches();

function readSsrInitialState(): unknown {
  const el = document.getElementById('treenix-initial');
  if (!el?.textContent) return undefined;
  try {
    return JSON.parse(el.textContent);
  } catch {
    return undefined;
  }
}

if (typeof document !== 'undefined') {
  hydrateFromServerSnapshot(readSsrInitialState());
}

const queryClient = new QueryClient();
const treeSource = createClientTreeSource();

// StrictMode off: FlowGram inversify container breaks on double-mount
// https://github.com/bytedance/flowgram.ai/issues/402
const Strict = ({ children }: { children: ReactNode }) => children;

/** Mount Treenix UI into a DOM element */
export function boot(el: HTMLElement | string = '#root') {
  const root = typeof el === 'string' ? document.querySelector(el) : el;
  if (!root) throw new Error(`Treenix boot: element "${el}" not found`);
  const tree = (
    <Strict>
      <TreeSourceProvider source={treeSource}>
        <AuthProvider>
          <QueryClientProvider client={queryClient}>
            <App />
            <Toaster />
          </QueryClientProvider>
        </AuthProvider>
      </TreeSourceProvider>
    </Strict>
  );
  // SSR-rendered? Then hydrate; else create fresh.
  if (root.firstElementChild) {
    hydrateRoot(root as HTMLElement, tree);
  } else {
    createRoot(root as HTMLElement).render(tree);
  }
}

// Auto-boot when loaded directly (not imported)
if (typeof document !== 'undefined' && document.getElementById('root')) {
  boot('#root');
}
