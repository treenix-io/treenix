// Treenix Mount — Layer 4
// Mount = component on node. Adapter resolved via context system.
// Core untouched. Tree interface preserved.

import { type ComponentData, getComponentByName, type NodeData, resolveExact } from '#core';
import { KernelError } from '#errors';
import { assertPatchManyBatch, isSetEntry, type Tree } from '#tree';
import { TRASH_ROOT } from '#tree/policy';

// core-anz4.8: /sys/trash/** is mount-INERT. A trashed node keeps its mount
// component, but under the trash prefix it is plain stored data — resolving it
// would let GC activate the mount, enumerate and DELETE external adapter
// content. Inertness is by-prefix (not by stripping the component): after
// restore the node returns to a normal path and the mount activates again.
function isTrashInert(path: string): boolean {
  return path === TRASH_ROOT || path.startsWith(TRASH_ROOT + '/');
}

/** The node's mount config when ACTIVE: present, not disabled, not trash-inert.
 *  The one activation rule for withMounts and the ACL read planner
 *  (resolve-plan.ts) — two diverging copies let a disabled or trashed query
 *  mount still drive reads, and trash GC hard-deleted the live view. */
export function activeMount(node: NodeData): ComponentData | undefined {
  if (isTrashInert(node.$path)) return undefined;
  const mount = getComponentByName(node, 'mount');
  return mount && !mount.disabled ? mount : undefined;
}

// ── Adapter contract ──
// Lives here so withMounts and adapters.ts share one definition; adapters.ts
// only registers.

export type MountCtx = {
  node: NodeData;
  path: string;
  parentStore: Tree;
  globalStore?: Tree;
  /** Mount adapter callback: wire an external watch source (Mongo change
   *  stream, FS watch, REST webhook) into the subscription bus. Available
   *  only when the host pipeline supplied a `startExternalWatch` to
   *  `withMounts`. The adapter is responsible for computing `pathPrefix`
   *  (mount root for non-shared mounts, '/' for shared). Returns an abort
   *  function — withMounts tracks it per mount and calls it when the mount
   *  is invalidated. */
  startExternalWatch?: ExternalWatchStarter;
};

export type ExternalWatchStarter = (
  tree: Tree,
  opts: { pathPrefix: string; dedupWindowMs?: number; source: string },
) => () => void;

export type WithMountsOpts = {
  startExternalWatch?: ExternalWatchStarter;
};

export type ActionTarget = { tree: Tree; mountPath: string };

/** withMounts return type — exposes `invalidateMount` so external-watch
 *  consumers can evict cached adapters when a mount config node is rewritten
 *  out-of-band. In-pipeline writes invalidate automatically (set/remove/patch). */
export type MountableTree = Tree & {
  invalidateMount(path: string): void;
  /** Resolve the first foreign authority on `path` and its local mount point —
   *  i.e. the adapter tree exposes the `execute` capability (transport mounts:
   *  t.mount.tree.trpc, future t.mount.peer). Storage mounts (memory/fs/mongo/
   *  query) and unmounted paths return undefined → the action runs in the
   *  LOCAL executor. Strict ancestors only (an action addressed at the mount
   *  node itself targets the local config node). */
  resolveActionTarget(path: string): Promise<ActionTarget | undefined>;
};

export type MountAdapter<T = unknown> = (mount: T, ctx: MountCtx) => Tree | Promise<Tree>;

declare module '#core/context' {
  interface ContextHandlers<T> {
    mount: MountAdapter<T>;
  }
}

export async function resolveAdapter(mount: ComponentData, mountCtx: MountCtx): Promise<Tree> {
  // Exact: the adapter set must equal what the F4 authoring gate sees
  // (security/acl.ts typeAclRule) — no registry fallback.
  const adapter = resolveExact(mount.$type, 'mount');
  if (!adapter) throw new KernelError('INVALID', `No mount adapter for "${mount.$type}" at ${mountCtx.path}`);
  return adapter(mount, mountCtx);
}

/** Paths whose mounts can own `path`: '/' and every strict ancestor, plus
 *  `path` itself when `withSelf` (a mount point's CHILDREN live in its
 *  adapter; the node itself lives in the store holding its config). */
function mountCandidates(path: string, withSelf: boolean): string[] {
  if (path === '/') return withSelf ? ['/'] : [];
  const out = ['/'];
  for (let i = path.indexOf('/', 1); i !== -1; i = path.indexOf('/', i + 1)) out.push(path.slice(0, i));
  if (withSelf) out.push(path);
  return out;
}

// ── Mountable Tree ──

type MountEntry = { tree: Promise<Tree>; release(): void };

export function withMounts(rootStore: Tree, opts?: WithMountsOpts): MountableTree {
  // One entry per mount-point path. Adapters are caller-blind (they never see
  // the requester), so the path alone is the key. The PROMISE is cached:
  // concurrent first accesses share one instance — two instances of a stateful
  // adapter (memory, external watch) would split writes or leak watches.
  const mounts = new Map<string, MountEntry>();

  /** Drop the mount at `path` and every mount below it (their configs were
   *  read through it). Release aborts the external watches they started. */
  function invalidateMount(path: string): void {
    for (const [key, entry] of mounts) {
      if (path !== '/' && key !== path && !key.startsWith(path + '/')) continue;
      mounts.delete(key);
      entry.release();
    }
  }

  function open(path: string, node: NodeData, mount: ComponentData, parentStore: Tree): MountEntry {
    const aborts: (() => void)[] = [];
    let released = false;
    const release = () => {
      released = true;
      for (const abort of aborts.splice(0)) abort();
    };

    const start = opts?.startExternalWatch;
    const startExternalWatch: ExternalWatchStarter | undefined = start && ((tree, watchOpts) => {
      const abort = start(tree, watchOpts);
      // Invalidated while the adapter was still resolving — nothing will
      // release this entry again.
      if (released) abort();
      else aborts.push(abort);
      return abort;
    });

    const entry: MountEntry = {
      tree: resolveAdapter(mount, { node, path, parentStore, globalStore: self, startExternalWatch }),
      release,
    };
    mounts.set(path, entry);
    // A failed adapter must not stay cached: the config stays editable and the
    // next access retries. Callers still get the rejection through entry.tree.
    entry.tree.catch(() => {
      if (mounts.get(path) === entry) mounts.delete(path);
      release();
    });
    return entry;
  }

  async function resolveTree(path: string, withSelf: boolean, ctx?: unknown, onAuthority?: (target: ActionTarget) => void): Promise<Tree> {
    let store = rootStore;
    for (const p of mountCandidates(path, withSelf)) {
      // Mounts at/under /sys/trash are inert (core-anz4.8) — their copied
      // subtree is plain data of the store that owns /sys/trash.
      if (isTrashInert(p)) break;

      let entry = mounts.get(p);
      if (!entry) {
        const node = await store.get(p, ctx);
        if (!node) continue;
        const mount = activeMount(node);
        if (!mount) continue;
        // Re-check: a concurrent walker may have opened it during the await.
        entry = mounts.get(p) ?? open(p, node, mount, store);
      }
      store = await entry.tree;
      if (onAuthority && store.execute) {
        // The remote authority owns routing below this local boundary.
        onAuthority({ tree: store, mountPath: p });
        break;
      }
    }
    return store;
  }

  // Writes invalidate AFTER the commit: a read re-resolving mid-write must not
  // re-cache the old config past the write.
  const self: MountableTree = {
    invalidateMount,

    async resolveActionTarget(path) {
      let target: ActionTarget | undefined;
      await resolveTree(path, false, undefined, (resolved) => { target = resolved; });
      return target;
    },

    async get(path, ctx) {
      return (await resolveTree(path, false, ctx)).get(path, ctx);
    },

    async getChildren(path, opts, ctx) {
      return (await resolveTree(path, true, ctx)).getChildren(path, opts, ctx);
    },

    // scanChildren dispatch — same per-path resolution as getChildren, but
    // streams. Legacy Tree-only adapters (no native scanChildren) fall back
    // to getChildren paging wrapped as an async generator — this keeps
    // remote/Mongo Tree-only mounts LISTABLE through the ACL/public path
    // (core-35t). The fallback CANNOT honor `after`: it always restarts from
    // the first page, so a cursor-paginating caller would silently get
    // duplicated/restarted pages (C13) — fail loud instead.
    async *scanChildren(path, opts, ctx) {
      const tree = await resolveTree(path, true, ctx);
      if (tree.scanChildren) {
        yield* tree.scanChildren(path, opts, ctx);
        return;
      }
      if (opts?.after !== undefined) {
        throw new KernelError('INVALID', `scanChildren: mount at ${path} is a Tree-only adapter without cursor support — 'after' pagination unavailable; migrate the adapter to native scanChildren`);
      }
      // limitHint is a batching hint only — it MUST NOT truncate the stream
      // (core-anz4.16: downstream ACL/query filters drop rows, so a single
      // limitHint-sized page under-reports). Page via nextCursor until the
      // source is exhausted; the lazy generator stops fetching once the
      // consumer stops pulling.
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        if (opts?.signal?.aborted) throw opts.signal.reason;
        if (cursor !== undefined) seen.add(cursor);
        const page = await tree.getChildren(path, { depth: opts?.depth, limit: opts?.limitHint, cursor }, ctx);
        for (const node of page.items) {
          yield { node, cursor: node.$path };
        }
        const next = page.nextCursor;
        // core-anz4.16: a legacy adapter returning a repeating/cyclic nextCursor
        // would loop forever — fail loud on the adapter-contract violation.
        if (next !== undefined && seen.has(next)) {
          throw new KernelError('INVALID', `scanChildren: mount at ${path} returned a repeating nextCursor "${next}" — cyclic pagination from a Tree-only adapter`);
        }
        cursor = next;
      } while (cursor !== undefined);
    },

    async set(node, ctx) {
      const receipt = await (await resolveTree(node.$path, false, ctx)).set(node, ctx);
      invalidateMount(node.$path);
      return receipt;
    },

    async remove(path, ctx) {
      const receipt = await (await resolveTree(path, false, ctx)).remove(path, ctx);
      invalidateMount(path);
      return receipt;
    },

    async patch(path, ops, ctx) {
      const receipt = await (await resolveTree(path, false, ctx)).patch(path, ops, ctx);
      invalidateMount(path);
      return receipt;
    },

    // patchMany (core-gk8.15): batch containment (asserted BEFORE resolution —
    // a non-contained entry would misroute) pins every member at-or-under
    // `ancestor`, so ONE resolution — the same set/patch use — owns the whole
    // batch. Forward only when the resolved tree carries the capability; a
    // silent per-member fallback loop would break atomicity.
    async patchMany(ancestor, entries, ctx) {
      assertPatchManyBatch(ancestor, entries);
      const tree = await resolveTree(ancestor, false, ctx);
      if (!tree.patchMany) {
        throw new KernelError('INVALID', `patchMany: target tree at ${ancestor} does not support patchMany`);
      }
      // A set-member may CREATE: if its path lives under a nested mount below
      // `ancestor`, forwarding to the ancestor's tree would silently create a
      // shadowed node in the outer store (an ops-member merely fails NOT_FOUND
      // there). Only set-members pay the extra per-path resolution.
      for (const e of entries) {
        if (isSetEntry(e) && await resolveTree(e.path, false, ctx) !== tree) {
          throw new KernelError('INVALID', `patchMany: set-member ${e.path} crosses a mount boundary under ${ancestor}`);
        }
      }
      const receipt = await tree.patchMany(ancestor, entries, ctx);
      for (const e of entries) invalidateMount(e.path);
      return receipt;
    },
  };

  return self;
}
