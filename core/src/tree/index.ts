// Treenix Tree — Layer 1
// Storage interface + in-memory implementation
// Depends only on core types.

import { comparePaths, isRef, type NodeData, type Ref } from '#core';
import { KernelError } from '#errors';
import { createSiftTest } from '#kernel/expr';
import { scanFromCollected } from './fs-common';
import { applyOps, type CommitChange, type CommitReceipt, hasMutationOps, type PatchOp, PatchTestError } from './patch';
import { isMoved } from './refs';
import type { TreeEvent, TreeWatchOpts, TreeWatchScope } from './watch';

// ── Pagination ──

export type PageOpts = { limit?: number; cursor?: string };
export type Page<T> = {
  items: T[];
  /** Number of items represented by the loaded window. It is not an exact
   *  cardinality contract; clients detect more pages via nextCursor. */
  total: number;
  truncated?: boolean;
  /** Opaque resume token for cursor pagination. Present ⇒ more pages exist. */
  nextCursor?: string;
};

export function paginate<T extends { $path: string }>(items: T[], opts?: PageOpts): Page<T> {
  const ordered = [...items].sort((a, b) => comparePaths(a.$path, b.$path));
  const start = opts?.cursor === undefined
    ? 0
    : ordered.findIndex(item => comparePaths(item.$path, opts.cursor!) > 0);
  if (start < 0) return { items: [], total: 0 };

  const pageItems = opts?.limit
    ? ordered.slice(start, start + opts.limit)
    : ordered.slice(start);
  const page: Page<T> = { items: pageItems, total: pageItems.length };
  if (opts?.limit && start + pageItems.length < ordered.length) {
    page.nextCursor = pageItems[pageItems.length - 1].$path;
  }
  return page;
}

// ── patchMany batch (core-gk8.15) ──

/** A batch member is either a patch (ops on an EXISTING node) or a set —
 *  a full-node write that may CREATE at a new path (core-gk8.10 stage 2:
 *  move() = set at destination + set tombstone at source, one atomic batch).
 *  Set semantics mirror Tree.set exactly: $rev present → OCC, absent → blind
 *  upsert. Discriminated union on purpose — optional fields would let ops-only
 *  consumers silently mishandle set-members instead of failing typecheck. */
export type PatchManyEntry =
  | { path: string; ops: PatchOp[] }
  | { path: string; node: NodeData };

export function isSetEntry(e: PatchManyEntry): e is { path: string; node: NodeData } {
  return 'node' in e;
}

/** Shared batch-shape guard for patchMany: non-empty, every entry contained
 *  under `ancestor`, no duplicate paths (apply order would be ambiguous),
 *  set-member node.$path consistent with its entry path.
 *  Wrappers that RESOLVE by ancestor (mounts) must call this before resolving —
 *  a non-contained entry would otherwise silently misroute to ancestor's tree. */
export function assertPatchManyBatch(ancestor: string, entries: PatchManyEntry[]): void {
  if (!entries.length) throw new KernelError('INVALID', 'patchMany: empty batch');

  const prefix = ancestor === '/' ? '/' : ancestor + '/';
  const seen = new Set<string>();
  for (const entry of entries) {
    const { path } = entry;
    if (path !== ancestor && !path.startsWith(prefix)) {
      throw new KernelError('INVALID', `patchMany: entry ${path} is outside ancestor ${ancestor}`);
    }
    if (seen.has(path)) throw new KernelError('INVALID', `patchMany: duplicate entry path ${path}`);
    seen.add(path);
    if (isSetEntry(entry) && entry.node.$path !== path) {
      throw new KernelError('INVALID', `patchMany: set-member node.$path ${entry.node.$path} does not match entry path ${path}`);
    }
  }
}

/** Phase-1 helper: apply an ops-member's ops to a clone of its node. A failing
 *  test op maps to CONFLICT — in a batch the test is a cross-member
 *  precondition (OCC guard), and the whole batch is denied on it. */
export function applyPatchManyEntry(node: NodeData, entry: { path: string; ops: PatchOp[] }): NodeData {
  const copy = structuredClone(node);
  try {
    applyOps(copy, entry.ops);
  } catch (e) {
    if (e instanceof PatchTestError) {
      throw new KernelError('CONFLICT', `patchMany: test failed for ${entry.path} (${e.field})`);
    }
    throw e;
  }
  return copy;
}

/** Phase-1 OCC gate for a set-member — same contract as Tree.set: $rev
 *  present must match the stored rev, absent is a blind upsert. Adapters run
 *  this DURING staging so an OCC loss denies the batch before anything
 *  commits (fs would otherwise hit its write-time OCC mid-batch). */
export function assertSetEntryOcc(stored: NodeData | undefined, entry: { path: string; node: NodeData }): void {
  if (entry.node.$rev != null && entry.node.$rev !== stored?.$rev) {
    throw new KernelError('CONFLICT', `patchMany: set-member ${entry.path} OCC failed — expected $rev ${stored?.$rev}, got ${entry.node.$rev}`);
  }
}

/** Memory-adapter staging: OCC gate + clone + $rev bump (mirror of its set();
 *  fs stages the raw clone instead — its writeNode owns OCC + bump).
 *  Rev advances from STORED (ns6p.4 invariant 24): a blind set-member over an
 *  existing node continues its rev line instead of resetting to 1 — resets
 *  made the client's ≤-skip branch swallow fresh events forever. */
export function stageSetEntry(stored: NodeData | undefined, entry: { path: string; node: NodeData }): NodeData {
  assertSetEntryOcc(stored, entry);
  const copy = structuredClone(entry.node);
  copy.$rev = (stored?.$rev ?? 0) + 1;
  return copy;
}

// ── Interface ──

export type ChildrenOpts = { depth?: number; query?: Record<string, unknown>; watch?: boolean; watchNew?: boolean } & PageOpts;

/** Options for Tree.execute. Identity (userId/claims/actor) is deliberately
 *  NOT here — it is bound when a tree is wrapped (server withExecute);
 *  otherwise a nested action handler could spoof another principal via
 *  ctx.tree.execute. */
export type ExecOpts = { type?: string; key?: string; opId?: string };

export interface Tree {
  get(path: string, ctx?: unknown): Promise<NodeData | undefined>;
  getChildren(path: string, opts?: ChildrenOpts, ctx?: unknown): Promise<Page<NodeData>>;
  /** Mutation verbs return a CommitReceipt (core-ns6p.2): what was committed,
   *  with before/after images minted inside the adapter's atomic span.
   *  Wrappers forward/translate it; cache/subs/audit consume it instead of
   *  re-reading. remove: `changes: []` = nothing existed (the old `false`). */
  set(node: NodeData, ctx?: unknown): Promise<CommitReceipt>;
  remove(path: string, ctx?: unknown): Promise<CommitReceipt>;
  patch(path: string, ops: PatchOp[], ctx?: unknown): Promise<CommitReceipt>;
  /** Atomic multi-node patch, all members at-or-under `ancestor` (core-gk8.15).
   *  ALL-OR-NOTHING: every member is validated (fresh read, ops applied on a
   *  clone, test ops evaluated) BEFORE anything commits — one failing member
   *  denies the whole batch. Optional capability (same precedent as
   *  scanChildren/execute): adapters implement natively, wrappers forward;
   *  absence throws INVALID at the forwarding layer — never a silent
   *  per-member fallback loop, which would break atomicity. */
  patchMany?(ancestor: string, entries: PatchManyEntry[], ctx?: unknown): Promise<CommitReceipt>;
  /** Server-internal traversal primitive. Optional on the public Tree
   *  interface: the wire-facing tRPC remote tree cannot implement it
   *  (no streaming over RPC), but every server-side adapter and wrapper
   *  exposes it. `executeList` throws INVALID at runtime
   *  if a non-source Tree slips into a server read path. */
  scanChildren?(
    path: string,
    opts?: ScanChildrenOpts,
    ctx?: unknown,
  ): AsyncIterable<ChildEntry>;
  /** Observe changes through the same Tree the caller writes to. Optional:
   *  storage adapters (Mongo today) MAY omit; outer wrappers like
   *  withSubscriptions provide a runtime that emits on every write that
   *  passes through them. Scope is a selector, not a promise that storage
   *  has native path-level filtering — wrappers MAY subscribe more broadly
   *  internally and filter before yielding. See `tree/watch.ts` for the
   *  contract (lifecycle, back-pressure, reconnect semantics). */
  watch?(
    scope: TreeWatchScope,
    opts?: TreeWatchOpts,
    ctx?: unknown,
  ): AsyncIterable<TreeEvent>;
  /** Execute an action at the authority owning the path. Optional capability:
   *  storage adapters omit it — actions on their nodes run in the LOCAL
   *  executor (server withExecute wrapper). Transport trees (tRPC / TWP wire)
   *  implement it — the call is delegated to the remote side, which resolves
   *  the handler and enforces permissions/validation under ITS principal
   *  (domain-owner trust model). Presence of this method on a mounted subtree
   *  marks foreign authority. */
  execute?(path: string, action: string, data?: unknown, opts?: ExecOpts, ctx?: unknown): Promise<unknown>;
}

// ── TreeSource: server-internal traversal primitive ──
// scanChildren is the pull-based alternative to getChildren. It yields one
// ChildEntry per direct/descendant node within `opts.depth`. Used by the
// read-runtime (executeList) to drive ACL projection + caller-query
// filtering with cursor pagination. Never crosses the RPC boundary.

export type ChildEntry = {
  node: NodeData;
  /** Opaque adapter-defined token encoding the entry's position in the
   *  adapter's deterministic total order. Pass back as `opts.after` to
   *  resume strictly after this entry. */
  cursor: string;
};

export type ScanChildrenOpts = {
  depth?: number;
  /** Exclusive cursor. The next yield SHALL be strictly after this entry
   *  in the adapter's total order. */
  after?: string;
  /** Soft hint; runtime decides when to stop. Adapters MAY batch
   *  accordingly but MUST NOT truncate based on it alone. */
  limitHint?: number;
  /** Adapter-specific pushdown plan. Runtime passes whatever
   *  `buildScanPlan(plan, actor)` produced for this adapter. Unknown
   *  shape is ignored by adapters that don't pushdown. */
  scanPlan?: unknown;
  signal?: AbortSignal;
};

/** Tree narrowed to require `execute` — what withExecute returns. The server
 *  pipeline tree and mod-service ctx.tree carry this type: services call
 *  `tree.execute` directly, no capability guard needed (core-pxlu). */
export type ExecTree = Tree & Required<Pick<Tree, 'execute'>>;

/** Tree narrowed to require `scanChildren` — server-internal read runtime
 *  uses this so callers express the dependency at the type level. Obtain
 *  one via `asTreeSource(tree)` or via adapters that always implement it
 *  (memory/fs/mimefs/combinators/pipeline wrappers). */
export type TreeSource = Tree & Required<Pick<Tree, 'scanChildren'>>;

/** Narrow a Tree to TreeSource. Throws if the tree doesn't expose
 *  `scanChildren` — the executeList path is server-side only and would
 *  silently break the no-fallback contract otherwise. */
export function asTreeSource(tree: Tree): TreeSource {
  if (!tree.scanChildren) {
    throw new KernelError('INVALID', 'Tree does not expose scanChildren — not usable as a source for the read runtime');
  }
  return tree as TreeSource;
}

// ── Ref resolution (id-first, core-gk8.10 stage 2) ──
// $ref path is a resolvable cache; $refId is the identity. Resolution follows
// 'moved' tombstone chains left by move(), verifies identity when both sides
// carry ids, and self-repairs standalone ref NODES: collapses the chain into
// $ref and adopts $refId — lazy adoption IS the migration of the legacy
// path-ref corpus.

const MAX_MOVED_HOPS = 8;

/** Follow tombstone redirects from `path` to the live node. `expectId` guards
 *  chain identity: a tombstone carrying a DIFFERENT $id means the path was
 *  reused by another node's move — that chain is not ours. */
export async function followMoved(
  tree: Tree,
  path: string,
  expectId?: string,
  ctx?: unknown,
): Promise<{ target: NodeData | undefined; hops: number }> {
  let target = await tree.get(path, ctx);
  let hops = 0;
  const seen = new Set<string>([path]);

  while (target && isMoved(target)) {
    if (expectId && target.$id && target.$id !== expectId) {
      throw new KernelError('NOT_FOUND', `Ref identity mismatch at ${path}: tombstone for ${target.$id}, expected ${expectId}`);
    }
    if (++hops > MAX_MOVED_HOPS) {
      throw new KernelError('INVALID', `Tombstone chain from ${path} exceeds ${MAX_MOVED_HOPS} hops`);
    }
    const next = target.$ref;
    if (seen.has(next)) throw new KernelError('INVALID', `Tombstone cycle at ${next}`);
    seen.add(next);
    target = await tree.get(next, ctx);
  }

  return { target, hops };
}

export async function resolveRef(tree: Tree, node: NodeData | Ref): Promise<NodeData> {
  if (!isRef(node)) return node;

  // A standalone ref NODE (came from the tree, carries $path) can be
  // repaired; an embedded ref object cannot — nothing to patch.
  const selfPath = '$path' in node && typeof node.$path === 'string' ? node.$path : undefined;
  const selfRev = '$rev' in node && typeof node.$rev === 'number' ? node.$rev : undefined;

  const expectId = node.$refId;
  const { target, hops } = await followMoved(tree, node.$ref, expectId);
  if (!target) throw new KernelError('NOT_FOUND', `Ref target not found: ${node.$ref}`);
  if (expectId && target.$id && target.$id !== expectId) {
    throw new KernelError('NOT_FOUND', `Ref identity mismatch: ${node.$ref} → ${target.$path} carries ${target.$id}, expected ${expectId}`);
  }

  // Self-repair: collapse a followed chain into $ref, adopt the target's id
  // ($refId adoption IS the lazy migration of the path-ref corpus).
  const adoptId = expectId === undefined && target.$id !== undefined;
  if ((hops > 0 || adoptId) && selfPath) {
    const ops: PatchOp[] = [];
    if (selfRev != null) ops.push(['t', '$rev', selfRev]);
    if (hops > 0) ops.push(['r', '$ref', target.$path]);
    if (adoptId) ops.push(['a', '$refId', target.$id]);
    try {
      await tree.patch(selfPath, ops);
    } catch (e) {
      // Repair is cache maintenance — the resolution above is already correct.
      // Read-only surfaces, ACL denials and concurrent edits are expected
      // here; the next resolve through a writable surface retries.
      console.error(`resolveRef: self-repair of ${selfPath} failed:`, e);
    }
  }

  return target;
}

// ── Filter tree ──
// Like overlay, but set() routes to upper only when filter matches, else lower.
// Reads merge both layers (upper wins). Remove tries both.
// Limiting is withheld from the layers (each returns its full child set) and
// applied once, post-merge, over the deduped union.
// Cost is full-fan-in per call — the cursor path (scanChildren) is the scalable
// read; this legacy merge remains for depth>1 until Stage 7 (core-6x8).

export function createFilterTree(
  upper: Tree,
  lower: Tree,
  toUpper: (node: NodeData) => boolean,
): Tree {
  // Post-commit shadow detection for upper creates. The read sits outside the
  // committing adapter's span: in-pipeline same-path writes are serialized by
  // the commit envelope, so only out-of-band lower drift can race it — and a
  // FAILING read must never report a committed write as failed. Any doubt
  // (shadow present, or the read itself erroring) degrades to opaque.
  async function shadowedOrUnknown(layer: Tree, path: string, ctx: unknown): Promise<boolean> {
    try {
      return await layer.get(path, ctx) !== undefined;
    } catch (e) {
      console.error(`createFilterTree: post-commit shadow check failed for ${path}:`, e);
      return true;
    }
  }

  return {
    async get(path, ctx) {
      return (await upper.get(path, ctx)) ?? (await lower.get(path, ctx));
    },
    async getChildren(parent, opts, ctx) {
      const passthrough = opts ? { depth: opts.depth, query: opts.query, watch: opts.watch, watchNew: opts.watchNew } : undefined;
      const [u, l] = await Promise.all([
        upper.getChildren(parent, passthrough, ctx),
        lower.getChildren(parent, passthrough, ctx),
      ]);
      const byPath = new Map<string, NodeData>();
      for (const n of l.items) byPath.set(n.$path, n);
      for (const n of u.items) byPath.set(n.$path, n);
      const result = paginate([...byPath.values()], opts);
      // A self-capping layer (ACL scan budget, remote page cap) must not
      // silently under-report through the merge (core-6x8).
      if (u.truncated || l.truncated) result.truncated = true;
      return result;
    },
    // Streaming k-way merge by $path cursor. Lazy: only pulls one entry
    // ahead from each side. Upper wins on path collision. Caller's `after`
    // is honored by each side; merger never re-yields.
    // Available only when BOTH sides expose scanChildren — Tree's scanChildren
    // is optional (wire-facing trees lack it), and silently degrading would
    // re-introduce the legacy-getChildren mixed-responsibilities path.
    async *scanChildren(parent, opts, ctx) {
      if (!upper.scanChildren || !lower.scanChildren) {
        throw new KernelError('INVALID', 'createFilterTree: scanChildren requires both layers to expose it');
      }
      const uIter = upper.scanChildren(parent, opts, ctx)[Symbol.asyncIterator]();
      const lIter = lower.scanChildren(parent, opts, ctx)[Symbol.asyncIterator]();
      try {
        let u = await uIter.next();
        let l = await lIter.next();
        while (!u.done || !l.done) {
          if (opts?.signal?.aborted) throw opts.signal.reason;
          if (u.done) { yield l.value!; l = await lIter.next(); continue; }
          if (l.done) { yield u.value!; u = await uIter.next(); continue; }
          const up = u.value!.node.$path;
          const lp = l.value!.node.$path;
          if (up === lp) { yield u.value!; u = await uIter.next(); l = await lIter.next(); }
          else if (up < lp) { yield u.value!; u = await uIter.next(); }
          else { yield l.value!; l = await lIter.next(); }
        }
      } finally {
        // Consumer broke early, or the merge threw/aborted — close BOTH inner
        // cursors so cursor-backed adapters (Mongo/fs) release resources.
        // The generator's own finally runs on early return()/throw; without
        // this the inner iterators' finally never fires (leaked cursors).
        await uIter.return?.();
        await lIter.return?.();
      }
    },
    async set(node, ctx) {
      if (toUpper(node)) {
        const receipt = await upper.set(node, ctx);
        // Upper CREATE over a visible lower node: the view's before-image was
        // lower's node, not null — but a post-commit lower.get is outside the
        // committing adapter's span and can tear under concurrency. Opaque is
        // the only honest receipt without a cross-layer atomic snapshot.
        const c = receipt.changes?.[0];
        if (c && c.before === null && await shadowedOrUnknown(lower, node.$path, ctx)) {
          return { changes: null };
        }
        return receipt;
      }
      const receipt = await lower.set(node, ctx);
      // Shadowed write: upper wins reads, so the view never shows the image
      // lower just committed — reporting it would poison caches with an
      // invisible node. View-level truth is unknowable here → opaque.
      if (await shadowedOrUnknown(upper, node.$path, ctx)) return { changes: null };
      return receipt;
    },
    async remove(path, ctx) {
      const a = await upper.remove(path, ctx);
      const b = await lower.remove(path, ctx);
      if (a.changes === null || b.changes === null) return { changes: null };
      // Upper wins reads, so its before-image is what the merged view served.
      return { changes: a.changes.length ? a.changes : b.changes };
    },
    async patch(path, ops, ctx) {
      const node = await upper.get(path, ctx) ?? await lower.get(path, ctx);
      if (!node) throw new KernelError('NOT_FOUND', `Node not found: ${path}`);
      const wasUpper = toUpper(node);

      // Apply ops to a copy to check if routing changes
      const patched = structuredClone(node);
      applyOps(patched, ops);
      const nowUpper = toUpper(patched);

      if (wasUpper === nowUpper) {
        // Same layer — patch in place
        if (wasUpper) return upper.patch(path, ops, ctx);
        return lower.patch(path, ops, ctx);
      }
      // Routing changed — relocate across layers. Strip $rev: the destination
      // store never issued it, so carrying the source's rev makes the first
      // write throw OCC against a node it never saw (core-yje D06). Set the
      // destination FIRST so a rejected write leaves the source intact rather
      // than dropping the node (remove-then-set is non-atomic — loses data if
      // the second write throws).
      const { $rev, ...relocated } = patched;
      const dest = wasUpper ? lower : upper;
      const src = wasUpper ? upper : lower;
      await dest.set(relocated, ctx);
      await src.remove(path, ctx);
      // The relocation is a NON-ATOMIC two-store composite: a concurrent
      // write can land between set and remove, so any synthesized image may
      // be stale. Opaque is the only honest receipt here.
      return { changes: null };
    },

    // patchMany routes the WHOLE batch to one layer — same get-based routing
    // as patch. Cross-layer splits are rejected: two independent stores cannot
    // commit as one atomic unit (and a per-layer split would break
    // all-or-nothing). No relocation either — batch members stay in their
    // layer even if ops flip the toUpper predicate.
    async patchMany(ancestor, entries, ctx) {
      assertPatchManyBatch(ancestor, entries);

      let layer: Tree | undefined;
      for (const entry of entries) {
        // Ops-member: route by the STORED node (must exist). Set-member: route
        // by the INCOMING node — parity with set(), and creates have nothing
        // stored to route by.
        let target: Tree;
        if (isSetEntry(entry)) {
          target = toUpper(entry.node) ? upper : lower;
        } else {
          const node = await upper.get(entry.path, ctx) ?? await lower.get(entry.path, ctx);
          if (!node) throw new KernelError('NOT_FOUND', `Node not found: ${entry.path}`);
          target = toUpper(node) ? upper : lower;
        }
        if (layer && target !== layer) {
          throw new KernelError('INVALID', 'patchMany cannot span layers');
        }
        layer = target;
      }

      // layer is set: assertPatchManyBatch guarantees a non-empty batch.
      if (!layer!.patchMany) {
        throw new KernelError('INVALID', 'patchMany: layer does not support patchMany');
      }
      const receipt = await layer!.patchMany(ancestor, entries, ctx);
      // Same shadowed-write rule as set(): a lower-routed member the upper
      // shadows commits invisibly — the batch receipt goes opaque.
      if (layer === lower && receipt.changes !== null) {
        for (const e of entries) {
          if (await shadowedOrUnknown(upper, e.path, ctx)) return { changes: null };
        }
      }
      // Upper-routed creates over visible lower nodes: view-before was lower,
      // but reading it post-commit can tear (outside the adapter span) — the
      // whole batch goes opaque (same rule as set()).
      if (layer === upper && receipt.changes !== null) {
        for (const c of receipt.changes) {
          if (c.before === null && await shadowedOrUnknown(lower, c.path, ctx)) {
            return { changes: null };
          }
        }
      }
      return receipt;
    },

    // execute routes to the layer owning the node — same logic as patch.
    // Exposed only when BOTH layers carry the capability: a mixed stack
    // (one foreign-authority layer + one storage layer) keeps today's local
    // executor semantics — per-node authority marking is a later contract
    // (core-pxlu design doc, "combinator table").
    ...(upper.execute && lower.execute ? {
      execute: async (path: string, action: string, data?: unknown, opts?: ExecOpts, ctx?: unknown) => {
        const node = await upper.get(path, ctx) ?? await lower.get(path, ctx);
        if (!node) throw new KernelError('NOT_FOUND', `Node not found: ${path}`);
        return toUpper(node)
          ? upper.execute!(path, action, data, opts, ctx)
          : lower.execute!(path, action, data, opts, ctx);
      },
    } : {}),
  };
}

// ── Overlay tree ──
// Reads: upper first, fall back to lower. Writes: upper only.
// Like createFilterTree(upper, lower, () => true) but remove only affects upper.

export function createOverlayTree(upper: Tree, lower: Tree): Tree {
  return {
    ...createFilterTree(upper, lower, () => true),
    async remove(path, ctx) {
      const receipt = await upper.remove(path, ctx);
      if (receipt.changes === null || receipt.changes.length === 0) return receipt;
      // Whiteout-free overlay: removing the upper copy REVEALS lower — the
      // view now serves lower's node, so the receipt carries it as the
      // after-image (caches stay view-correct; the remove event still fires,
      // parity with the pre-receipt contract).
      const revealed = await lower.get(path, ctx);
      if (revealed === undefined) return receipt;
      return { changes: [{ ...receipt.changes[0], after: revealed }] };
    },
  };
}

// ── $ ↔ _ key mapping (D06: Mongo/sift storage compat) ──
// $-prefixed system keys ($path, $type, $acl, ...) become _-prefixed for
// storage: Mongo forbids $-keys, and sift queries are pre-mapped by
// `mapSiftQuery`, so nodes must match the same form. Layer-1 concern —
// lived in core/component.ts until 2026-07 (core-tbcn).

export function toStorageKeys(node: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    // $id maps to _tid (treenix id), NOT _id — Mongo's immutable primary key
    // (D06: _id is skipped on read; the generic mapping would swallow identity).
    if (k === '$id') { out['_tid'] = v; continue; }
    out[k.startsWith('$') ? `_${k.slice(1)}` : k] = v;
  }
  return out;
}

export function fromStorageKeys(doc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k === '_id') continue;
    if (k === '_tid') { out['$id'] = v; continue; }
    out[k.startsWith('_') ? `$${k.slice(1)}` : k] = v;
  }
  return out;
}

export function mapNodeForSift(node: NodeData): Record<string, unknown> {
  return toStorageKeys(node);
}

// ── In-memory implementation ──

export type TreeNode<T> = {
  data?: T;
  children: Map<string, TreeNode<T>>;
};

export function treeNavigate<T>(root: TreeNode<T>, path: string): TreeNode<T> | undefined {
  if (path === '/') return root;
  const parts = path.slice(1).split('/');
  let node = root;
  for (const part of parts) {
    const child = node.children.get(part);
    if (!child) return undefined;
    node = child;
  }
  return node;
}

export function treeEnsure<T>(root: TreeNode<T>, path: string): TreeNode<T> {
  if (path === '/') return root;
  const parts = path.slice(1).split('/');
  let node = root;
  for (const part of parts) {
    let child = node.children.get(part);
    if (!child) {
      child = { children: new Map() } as TreeNode<T>;
      node.children.set(part, child);
    }
    node = child;
  }
  return node;
}

export function createMemoryTree(): TreeSource {
  const root: TreeNode<NodeData> = { children: new Map() };
  const navigate = (path: string) => treeNavigate(root, path);
  const ensurePath = (path: string) => treeEnsure(root, path);

  function collectChildren(
    node: TreeNode<NodeData>,
    parentPath: string,
    maxDepth: number,
    currentDepth: number = 1,
  ): NodeData[] {
    const result: NodeData[] = [];
    const deep = maxDepth < 0; // -1 (any negative) = all descendants, the wire-safe deep sentinel
    if (!deep && currentDepth > maxDepth) return result;

    for (const [name, child] of node.children) {
      if (child.data) result.push(child.data);
      if (deep || currentDepth < maxDepth) {
        const childPath = parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;
        result.push(...collectChildren(child, childPath, maxDepth, currentDepth + 1));
      }
    }
    return result;
  }

  return {
    async get(path, _ctx) {
      if (typeof path !== 'string') throw new Error(`tree.get: path must be string, got ${typeof path}`);
      const data = navigate(path)?.data;
      return data ? structuredClone(data) : data;
    },

    async getChildren(parent, opts, _ctx) {
      const node = navigate(parent);
      if (!node) return { items: [], total: 0 };
      const depth = opts?.depth ?? 1;
      let result = collectChildren(node, parent, depth);
      if (opts?.query) {
        const test = createSiftTest(opts.query);
        result = result.filter(n => test(mapNodeForSift(n)));
      }
      return paginate(result, opts);
    },

    // Clone upfront so the in-memory store stays isolated from caller
    // mutation; scanFromCollected owns sort/cursor/signal contract.
    async *scanChildren(parent, opts, _ctx) {
      const node = navigate(parent);
      if (!node) return;
      const cloned = collectChildren(node, parent, opts?.depth ?? 1).map(d => structuredClone(d));
      yield* scanFromCollected(cloned, opts);
    },

    async set(node, _ctx) {
      const treeNode = ensurePath(node.$path);

      if (node.$rev != null) {
        // OCC: caller knows about rev — must match stored
        const prevRev = treeNode.data?.$rev;
        if (node.$rev !== prevRev) {
          throw new KernelError('CONFLICT', `OptimisticConcurrencyError: node ${node.$path} modified by another transaction. Expected $rev ${prevRev}, got ${node.$rev}`);
        }
      }

      // Receipt images: before = the replaced store object (orphaned by the
      // swap — exclusively ours); after = a second clone so the receipt never
      // aliases live store state (isolation, same reason get() clones).
      const before = treeNode.data ?? null;
      // Advance from STORED (invariant 24): blind set continues the rev line.
      // On the OCC path incoming === stored by the check above — same value.
      node.$rev = (before?.$rev ?? 0) + 1;
      const stored = structuredClone(node);
      treeNode.data = stored;
      return { changes: [{ path: node.$path, before, after: structuredClone(stored) }] };
    },

    async remove(path, _ctx) {
      const treeNode = navigate(path);
      if (!treeNode?.data) return { changes: [] };
      const before = treeNode.data;
      treeNode.data = undefined;
      return { changes: [{ path, before, after: null }] };
    },

    async patch(path, ops, _ctx) {
      const treeNode = navigate(path);
      if (!treeNode?.data) throw new KernelError('NOT_FOUND', `Node not found: ${path}`);
      const copy = structuredClone(treeNode.data);
      applyOps(copy, ops);
      if (!hasMutationOps(ops)) {
        return { changes: [{ path, before: copy, after: copy }] };
      }
      copy.$rev = (copy.$rev ?? 0) + 1;
      const before = treeNode.data;
      treeNode.data = copy;
      return { changes: [{ path, before, after: structuredClone(copy) }] };
    },

    // ALL-OR-NOTHING (core-gk8.15): phase 1 stages every member (fresh read,
    // clone, ops incl. test ops applied) — any failure throws before anything
    // is written. Phase 2 swaps data refs in a synchronous loop with NO await
    // between swaps: that synchronicity IS the atomicity — no interleaved
    // read or write can observe a half-applied batch.
    async patchMany(ancestor, entries, _ctx) {
      assertPatchManyBatch(ancestor, entries);

      const staged: { treeNode: TreeNode<NodeData>; copy: NodeData }[] = [];
      const changes: CommitChange[] = [];
      for (const entry of entries) {
        if (isSetEntry(entry)) {
          // Set-member: may CREATE — ensurePath instead of navigate. OCC in
          // phase 1 (stageSetEntry) so a conflict denies before any swap.
          const treeNode = ensurePath(entry.path);
          const copy = stageSetEntry(treeNode.data, entry);
          staged.push({ treeNode, copy });
          changes.push({ path: entry.path, before: treeNode.data ?? null, after: structuredClone(copy) });
          continue;
        }
        const treeNode = navigate(entry.path);
        if (!treeNode?.data) throw new KernelError('NOT_FOUND', `Node not found: ${entry.path}`);
        const copy = applyPatchManyEntry(treeNode.data, entry);
        // Test-only member: evaluated above, never written, no $rev bump —
        // same per-node rule as patch. Reported as a guarded no-op member.
        if (!hasMutationOps(entry.ops)) {
          changes.push({ path: entry.path, before: copy, after: copy });
          continue;
        }
        copy.$rev = (copy.$rev ?? 0) + 1;
        staged.push({ treeNode, copy });
        changes.push({ path: entry.path, before: treeNode.data, after: structuredClone(copy) });
      }

      for (const s of staged) s.treeNode.data = s.copy;
      return { changes };
    },
  };
}

export { type CommitChange, type CommitReceipt, type PatchOp, PatchTestError, applyOps, assertSafePatchPath, hasMutationOps, patchViaSet } from './patch';
// Curated door for trusted in-process relocation (core-anz4.2): mods that
// legitimately carry $id to a new path (branch merge) import it here — the
// policy module itself stays private.
export { relocateCtx } from './policy';
export { type TreeEvent, type TreeWatchScope, type TreeWatchOpts, subscriptionToAsyncIterable } from './watch';
