// onboarding seed — mounts ./docs/ as /docs and points /_index at /docs/welcome.md.
// Opt-in: add "onboarding" to root.json `seeds` list.

import { type NodeData } from '@treenx/core';
import { registerPrefab } from '@treenx/core/mod';
import { join } from 'node:path';

registerPrefab('onboarding', 'seed', [
  { $path: 'docs', $type: 'mount-point', mount: { $type: 't.mount.rawfs', root: '' } },
  { $path: 'sys/routes/_index', $type: 'ref', $ref: '/docs/welcome.md' },
] as NodeData[], (nodes) => {
  const root = process.env.DOCS_ROOT || join(process.cwd(), 'docs');
  return nodes.map(n => n.$path === 'docs' ? { ...n, mount: { ...(n.mount as Record<string, unknown>), root } } : n);
});
