// t.route — routing metadata on a node under /sys/routes.
// Presence is what marks a node as a route entry; wildcard catches descendant URL paths.

import { registerType } from '@treenx/core/comp';

/** Routing hint. Attach to a /sys/routes/* node. */
export class Route {
  /** When true, this route catches descendant URL paths (e.g. /sys/routes/t catches /t/anything). */
  wildcard?: boolean;
}

registerType('t.route', Route);
