// editor-shell seed — registers /sys/routes/t with a wildcard route, so the
// unified router catches /t/anything and renders this mod's view.

import { registerPrefab } from '@treenx/core/mod';

registerPrefab('editor-shell', 'seed', [
  {
    $path: 'sys/routes/t',
    $type: 't.editor.shell',
    route: { $type: 't.route', wildcard: true },
  },
], undefined, { tier: 'core' });
