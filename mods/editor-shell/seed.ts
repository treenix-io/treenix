// editor-shell seed — registers /sys/routes/t with a wildcard route, so the
// unified router catches /t/anything and renders this mod's view.

import { registerPrefab } from '@treenx/core/mod';
import { seedNodes } from './seed-data';

registerPrefab('editor-shell', 'seed', seedNodes, undefined, { tier: 'core' });
