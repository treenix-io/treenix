import { type NodeData } from '@treenx/core';
import { registerPrefab } from '@treenx/core/mod';
import { join } from 'node:path';

registerPrefab('doc', 'seed', [
  { $path: 'docs', $type: 'mount-point', mount: { $type: 't.mount.fs', root: '' } },
] as NodeData[], (nodes) => {
  const root = process.env.DOCS_ROOT || join(process.cwd(), 'docs');
  return nodes.map(n => n.$path === 'docs' ? { ...n, mount: { ...(n.mount as Record<string, unknown>), root } } : n);
}, { tier: 'core' });
