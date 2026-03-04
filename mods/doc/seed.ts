import { type NodeData } from '@treenity/core/core';
import { registerPrefab } from '@treenity/core/mod';
import { join } from 'node:path';

registerPrefab('doc', 'seed', [
  { $path: 'docs', $type: 'mount-point', mount: { $type: 't.mount.fs' }, root: '' },
] as NodeData[], (nodes) => {
  const root = process.env.DOCS_ROOT || join(process.cwd(), 'docs');
  return nodes.map(n => n.$path === 'docs' ? { ...n, root } : n);
}, { tier: 'core' });
