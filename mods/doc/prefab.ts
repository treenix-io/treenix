import { type NodeData } from '@treenity/core/core';
import { registerPrefab } from '@treenity/core/mod';
import { mdToTiptap } from './markdown';

// FS mount-point for a docs directory
// Setup accepts { root: string } to set the filesystem path
registerPrefab('doc', 'library', [
  { $path: '.', $type: 'mount-point', mount: { $type: 't.mount.fs' }, root: '' },
] as NodeData[], (nodes, params) => {
  const p = params as { root?: string } | undefined;
  if (!p?.root) return nodes;
  return nodes.map(n => n.$path === '.' ? { ...n, root: p.root } : n);
});

// Sample doc.page node
const welcomeMd = `A rich document with **bold**, *italic*, and \`code\`.

- Stored as Tiptap JSON
- Editable with WYSIWYG toolbar
- Supports embedded Treenity components via /slash commands`;

const welcomeContent = JSON.stringify(mdToTiptap(welcomeMd));

registerPrefab('doc', 'demo', [
  { $path: 'welcome', $type: 'doc.page', title: 'Welcome to Docs', content: welcomeContent },
] as NodeData[]);
