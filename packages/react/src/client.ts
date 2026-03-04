/// <reference types="vite/client" />
// The browser peer node — singleton client tree.
// /local/* in memory, everything else via tRPC.

import { createClientTree } from './client-tree';
import { trpc } from './trpc';

export const { tree, local, remote } = createClientTree(trpc);

// Dev: expose tree for console debugging (e.g. __tree.get('/local/ui/theme'))
if (import.meta.env?.DEV) (globalThis as any).__tree = tree;
