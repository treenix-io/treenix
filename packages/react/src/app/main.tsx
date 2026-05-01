import 'reflect-metadata';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { enablePatches } from 'immer';
import { type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AuthProvider } from './auth-context';
import '#tree/load-client';
import { createClientTreeSource } from '#tree/client-tree-source';
import { TreeSourceProvider } from '#tree/tree-source-context';
import { Toaster } from '#components/ui/sonner';
import '../root.css';

enablePatches();

const queryClient = new QueryClient();
const treeSource = createClientTreeSource();

// StrictMode off: FlowGram inversify container breaks on double-mount
// https://github.com/bytedance/flowgram.ai/issues/402
const Strict = ({ children }: { children: ReactNode }) => children;

/** Mount Treenix UI into a DOM element */
export function boot(el: HTMLElement | string = '#root') {
  const root = typeof el === 'string' ? document.querySelector(el) : el;
  if (!root) throw new Error(`Treenix boot: element "${el}" not found`);
  createRoot(root as HTMLElement).render(
    <Strict>
      <TreeSourceProvider source={treeSource}>
        <AuthProvider>
          <QueryClientProvider client={queryClient}>
            <App />
            <Toaster />
          </QueryClientProvider>
        </AuthProvider>
      </TreeSourceProvider>
    </Strict>,
  );
}

// Auto-boot when loaded directly (not imported)
if (typeof document !== 'undefined' && document.getElementById('root')) {
  boot('#root');
}
