// Transport-agnostic ACL filter for watch events.
// Sits between WatchManager and any transport (tRPC, HTTP, WS).
// Ensures users only receive events they're authorized to see.

import { isComponent, type NodeData, R } from '#core';
import type { Tree } from '#tree';
import type { Operation } from 'fast-json-patch';
import { buildClaims, componentPerm, resolvePermission, stripComponents } from './auth';
import type { NodeEvent } from './sub';

export type EventPush = (event: NodeEvent) => void;

export type WatchFilterOpts = {
  claimsTtlMs?: number;
};

const DEFAULT_CLAIMS_TTL_MS = 30_000;

/**
 * Filter RFC 6902 patch operations, removing ops that target restricted components.
 * Patch paths are like "/componentKey/field" — first segment is the node key.
 */
export function filterPatches(
  patches: Operation[],
  node: NodeData,
  userId: string | null,
  claims: string[],
): Operation[] {
  return patches.filter(op => {
    const seg = op.path.split('/')[1];
    if (!seg || seg.startsWith('$')) return true;
    const val = node[seg];
    if (!isComponent(val)) return true;
    return !!(componentPerm(val, userId, claims, node.$owner) & R);
  });
}

/**
 * Create an ACL-filtered push function for a specific user session.
 * Wraps a raw push channel, dropping/stripping events the user cannot see.
 */
export function createFilteredPush(
  store: Tree,
  userId: string,
  sessionClaims: string[] | null,
  push: EventPush,
  opts?: WatchFilterOpts,
): EventPush {
  const claimsTtlMs = opts?.claimsTtlMs ?? DEFAULT_CLAIMS_TTL_MS;

  let dynamicClaims: string[] | null = null;
  let dynamicAt = 0;

  const getClaims = async () => {
    if (sessionClaims) return sessionClaims;
    if (!dynamicClaims || Date.now() - dynamicAt > claimsTtlMs) {
      dynamicClaims = await buildClaims(store, userId);
      dynamicAt = Date.now();
    }
    return dynamicClaims;
  };

  return (event: NodeEvent) => {
    filterEvent(store, event, userId, getClaims, push).catch(() => {});
  };
}

async function filterEvent(
  store: Tree,
  event: NodeEvent,
  userId: string,
  getClaims: () => Promise<string[]>,
  push: EventPush,
) {
  if (event.type === 'reconnect') { push(event); return; }

  // Remove: node is already deleted — check parent ACL instead.
  // If user can read parent, they see children come and go.
  if (event.type === 'remove') {
    const claims = await getClaims();
    const parent = event.path.slice(0, event.path.lastIndexOf('/')) || '/';
    const perm = await resolvePermission(store, parent, userId, claims);
    if (perm & R) push(event);
    return;
  }

  const claims = await getClaims();
  const perm = await resolvePermission(store, event.path, userId, claims);
  if (!(perm & R)) return;

  if (event.type === 'set' && event.node) {
    const fullNode = { $path: event.path, ...event.node } as NodeData;
    const stripped = stripComponents(fullNode, userId, claims);
    const { $path, ...body } = stripped;
    push({ ...event, node: body });
  } else if (event.type === 'patch' && event.patches.length > 0) {
    const node = await store.get(event.path);
    if (!node) { push(event); return; }
    const filtered = filterPatches(event.patches, node, userId, claims);
    if (filtered.length === 0) return;
    push(filtered.length === event.patches.length ? event : { ...event, patches: filtered });
  } else {
    push(event);
  }
}
