// Barrel: all mod client registrations (dynamic — one broken mod won't crash others)
import { loadMod } from '@treenity/react/mod-errors';

await Promise.allSettled([
  loadMod('agent', () => import('./agent/client')),
  loadMod('simple-components', () => import('./simple-components/client')),
  loadMod('board', () => import('./board/client')),
  loadMod('brahman', () => import('./brahman/client')),
  loadMod('doc', () => import('./doc/client')),
  loadMod('launcher', () => import('./launcher/client')),
  loadMod('metatron', () => import('./metatron/client')),
  loadMod('mindmap', () => import('./mindmap/client')),
  loadMod('sensor-demo', () => import('./sensor-demo/client')),
  loadMod('sensor-generator', () => import('./sensor-generator/client')),
  loadMod('sim', () => import('./sim/client')),
  loadMod('table', () => import('./table/client')),
  loadMod('todo', () => import('./todo/client')),
  loadMod('whisper', () => import('./whisper/client')),
  loadMod('mcp', () => import('./mcp/client')),
]);
