// t.route — routing metadata on a node under /sys/routes.
// Presence is what marks a node as a route entry; wildcard catches descendant
// URL paths. prefix/index let a route mount a tree subtree under a custom URL
// prefix (e.g. /sys/routes/d with prefix='/docs', index='index' exposes
// /docs/foo at /d/foo and /docs/index at /d).

import { registerType } from '@treenx/core/comp';

/** Routing hint. Attach to a /sys/routes/* node. */
export class Route {
  /** When true, this route catches descendant URL paths (e.g. /sys/routes/t catches /t/anything). */
  wildcard?: boolean;
  /** Tree path prefix this route mounts. Empty/absent → URL maps 1:1 to tree path. */
  prefix?: string;
  /** Default child name when URL rest is empty (e.g. 'index'). */
  index?: string;
  /** When true, route renders for unauthenticated users (no global login modal). */
  public?: boolean;
}

registerType('t.route', Route);
