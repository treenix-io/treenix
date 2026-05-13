// Audit infra — append-only journal mounted at /sys/audit/event.
// Backed by a Mongo collection so events accumulate without TTL by default;
// retention policy is set per-deployment, not at this layer.

import { A, R, S, W } from '@treenx/core';
import { registerPrefab } from '@treenx/core/mod';

registerPrefab('audit', 'seed', [
  { $path: 'sys/audit', $type: 'dir',
    $acl: [{ g: 'admins', p: R | W | A | S }, { g: 'authenticated', p: 0 }, { g: 'public', p: 0 }],
  },
  { $path: 'sys/audit/event', $type: 'mount-point',
    mount: { $type: 't.mount.mongo', db: 'treenix', collection: 'audit_events' },
    // admins read; everyone else denied. Workload writes flow through `withAudit`
    // (system context bypasses the agent ACL — see audit/with-audit.ts).
    $acl: [{ g: 'admins', p: R | W | A | S }, { g: 'authenticated', p: 0 }, { g: 'public', p: 0 }],
  },
], undefined, { tier: 'core' });
