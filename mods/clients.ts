import { clientModules as declaredOwner0 } from './agent/types';
import { clientModules as declaredOwner1 } from './board/types';
import { clientModules as declaredOwner2 } from './simple-components/types';
import { clientModules as declaredOwner3 } from './brahman/types';
import { clientModules as declaredOwner4 } from './doc/types';
import { clientModules as declaredOwner5 } from './editor-shell/types';
import { clientModules as declaredOwner6 } from './launcher/types';
import { clientModules as declaredOwner7 } from './todo/types';
import { clientModules as declaredOwner8 } from './mcp/types';
import { clientModules as declaredOwner9 } from './mcp/treenix-tool-types';
import { clientModules as declaredOwner10 } from './metatron/types';
import { clientModules as declaredOwner11 } from './mindmap/types';
import { clientModules as declaredOwner12 } from './row-layout/types';
import { clientModules as declaredOwner13 } from './sensor-demo/types';
import { clientModules as declaredOwner14 } from './sim/types';
import { clientModules as declaredOwner15 } from './table/types';
import { clientModules as declaredOwner16 } from './three/types';
import { clientModules as declaredOwner17 } from './view-shell/types';
import { clientModules as declaredOwner18 } from './whisper/types';
// Barrel: all mod client registrations.
// Read by vite-plugin-treenix via `treenix.clients` in package.json.
import { clientModules as declaredClient0 } from './agent/client';
import { clientModules as declaredClient1 } from './board/client';
import { clientModules as declaredClient2 } from './brahman/client';
import { clientModules as declaredClient3 } from './doc/client';
import { clientModules as declaredClient4 } from './editor-shell/client';
import { clientModules as declaredClient5 } from './launcher/client';
import { clientModules as declaredClient6 } from './mcp/client';
import { clientModules as declaredClient7 } from './metatron/client';
import { clientModules as declaredClient8 } from './mindmap/client';
import { clientModules as declaredClient9 } from './row-layout/client';
import { clientModules as declaredClient10 } from './sensor-demo/client';
import { clientModules as declaredClient11 } from './sensor-generator/client';
import { clientModules as declaredClient12 } from './sim/client';
import { clientModules as declaredClient13 } from './simple-components/client';
import { clientModules as declaredClient14 } from './table/client';
import { clientModules as declaredClient15 } from './three/client';
import { clientModules as declaredClient16 } from './todo/client';
import { clientModules as declaredClient17 } from './view-shell/client';
import { clientModules as declaredClient18 } from './whisper/client';

export const clientModules = [
  ...declaredOwner0,
  ...declaredOwner1,
  ...declaredOwner2,
  ...declaredOwner3,
  ...declaredOwner4,
  ...declaredOwner5,
  ...declaredOwner6,
  ...declaredOwner7,
  ...declaredOwner8,
  ...declaredOwner9,
  ...declaredOwner10,
  ...declaredOwner11,
  ...declaredOwner12,
  ...declaredOwner13,
  ...declaredOwner14,
  ...declaredOwner15,
  ...declaredOwner16,
  ...declaredOwner17,
  ...declaredOwner18,
  ...declaredClient0,
  ...declaredClient1,
  ...declaredClient2,
  ...declaredClient3,
  ...declaredClient4,
  ...declaredClient5,
  ...declaredClient6,
  ...declaredClient7,
  ...declaredClient8,
  ...declaredClient9,
  ...declaredClient10,
  ...declaredClient11,
  ...declaredClient12,
  ...declaredClient13,
  ...declaredClient14,
  ...declaredClient15,
  ...declaredClient16,
  ...declaredClient17,
  ...declaredClient18,
];
