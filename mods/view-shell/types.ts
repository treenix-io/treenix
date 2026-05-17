// t.view.shell — read-only node viewer route. Marker type; the React view
// renders the node at the URL tail in a chosen rendering context (default
// 'react'). Mounted at /sys/routes/v with a wildcard so /v/anything resolves
// here.

import { registerType } from '@treenx/core/comp';

/** Read-only viewer route node. */
export class ViewShell {
  /** When true, keep the viewed target live via the client tree event stream. */
  reactive?: boolean;
}

registerType('t.view.shell', ViewShell);
