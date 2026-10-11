// view-shell seed — registers /sys/routes/v with a wildcard route, so the
// unified router catches /v/anything and renders this mod's view.

import { registerPrefab } from '@treenx/core/mod';
import { seedNodes } from './seed-data';

registerPrefab('view-shell', 'seed', seedNodes, undefined, { tier: 'core' });
