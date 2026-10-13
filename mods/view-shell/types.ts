import { declareClientType } from '@treenx/core/comp/client-declaration';
import { declareOpenModule } from '@treenx/core/kernel/module-declaration';
// t.view.shell — read-only node viewer route. Marker type; the React view
// renders the node at the URL tail in a chosen rendering context (default
// 'react'). Mounted at /sys/routes/v with a wildcard so /v/anything resolves
// here.



/** Read-only viewer route node. */
export class ViewShell {
  /** When true, keep the viewed target live via the client tree event stream. */
  reactive?: boolean;
}

const declaredTViewShell = declareClientType('t.view.shell', ViewShell);

export const clientModules = [declareOpenModule('@treenx/mods/view-shell/types', [], [
  declaredTViewShell,
])];
