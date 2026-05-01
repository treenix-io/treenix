// view-shell seed — registers /sys/routes/v with a wildcard route, so the
// unified router catches /v/anything and renders this mod's view.

import type { NodeData } from '@treenx/core';
import { registerPrefab } from '@treenx/core/mod';

registerPrefab('view-shell', 'seed', [
  {
    $path: 'sys/routes/v',
    $type: 't.view.shell',
    route: { $type: 't.route', wildcard: true },
  },
] as NodeData[], undefined, { tier: 'core' });
