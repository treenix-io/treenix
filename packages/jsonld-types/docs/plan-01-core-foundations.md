# JSON-LD Types — Core Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two small, generally-useful primitives to `@treenx/core` that unblock lazy type-resolution patterns (the JSON-LD type-pack package will be built on top of these in a follow-up plan).

**Architecture:** Two surgical additions to `engine/core/src/core/registry.ts`:
1. **Sync-miss re-check** in `resolve()` — after a synchronous miss resolver runs, re-check the registry before falling through to default. Required so `validate.ts:133` doesn't silently skip validation for lazy-registered types on their first use.
2. **`replaceHandler(type, ctx, handler, meta?)`** — atomic `unregister + register` helper. Lets callers explicitly override an existing entry (HMR, inheritance fallback override). Plain `register()` keeps its silent-dedup contract.

Both are zero-dep TypeScript-only additions. No mods, no React, no new deps. Both ship behind tests in the existing [`engine/core/src/core/index.test.ts`](engine/core/src/core/index.test.ts) suite.

**Tech Stack:** TypeScript strict, ESM, `node:test` runner via `npm test` (passes `--conditions development` so `#*` resolves to `src/`).

**Spec:** This plan implements ACs 14, 17, 21 from [AUTO_REVIEW_JSONLD_TYPES.md](../../AUTO_REVIEW_JSONLD_TYPES.md):
- AC14: exact view registered after inherited fallback overrides correctly when caller uses `replaceHandler`.
- AC17 (revised): `replaceHandler(type, ctx, handler)` overrides any prior registration; plain `register()` no-ops.
- AC21: `validateNode` enforces validation on first `set` for a never-resolved sync-lazy-registered type (requires the registry re-check fix).

**Out of scope:** the JSON-LD pack itself, mount adapter, validators, vendored snapshot, ontology migration. All deferred to subsequent plans once these foundations land green.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `engine/core/src/core/registry.ts` | Modify line 47-65 (resolve) and append `replaceHandler` | Two new primitives |
| `engine/core/src/core/index.test.ts` | Append a new `describe('Lazy resolver semantics', ...)` block and `describe('replaceHandler', ...)` block | Tests for both additions |

No new files. No existing tests touched. No barrel re-exports needed (`registry.ts` is already re-exported by [`engine/core/src/core/index.ts`](engine/core/src/core/index.ts) via `export * from './registry'`, which is in turn re-exported by [`engine/core/src/index.ts`](engine/core/src/index.ts) line 1).

---

## Task 1: Add failing test — sync miss resolver completes in same `resolve()` call

**Files:**
- Modify: `engine/core/src/core/index.test.ts` (append at end of file)

- [ ] **Step 1: Update the `node:test` import to include `afterEach`**

In `engine/core/src/core/index.test.ts`, find line 4:

```ts
import { describe, it } from 'node:test';
```

Replace with:

```ts
import { afterEach, describe, it } from 'node:test';
```

- [ ] **Step 2: Write the failing test**

Append the following block to the end of `engine/core/src/core/index.test.ts`:

```ts
describe('Lazy resolver semantics (sync miss)', () => {
  afterEach(() => {
    // onResolveMiss is singleton-per-context; reset to noop so this describe block
    // does not leak a 'schema' resolver into other test suites.
    onResolveMiss('schema', () => {});
  });

  it('returns handler registered synchronously by miss resolver in same resolve() call', () => {
    const snap = saveRegistrySnapshot();
    try {
      const TYPE = 'lazy.synctest.A';
      let parseCount = 0;

      onResolveMiss('schema', (type) => {
        if (type !== TYPE) return;
        parseCount++;
        register(type, 'schema', () => ({ $id: type, type: 'object' as const, title: 'A', properties: {} }));
      });

      const handler = resolve(TYPE, 'schema');
      assert.ok(handler, 'sync miss resolver registered handler — resolve must return it on first call, not null');
      assert.equal(parseCount, 1, 'resolver must run exactly once');
      const schema = (handler as any)();
      assert.equal(schema.$id, TYPE);
    } finally {
      restoreRegistrySnapshot(snap);
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run from project root:

```bash
npm test -- --test-name-pattern="returns handler registered synchronously"
```

Expected: FAIL with assertion error message `sync miss resolver registered handler — resolve must return it on first call, not null` (current `resolve()` returns `null` after `missResolvers.get(context)?.(n)` because it never re-checks the registry).

- [ ] **Step 4: Commit the failing test**

```bash
git add engine/core/src/core/index.test.ts
git commit -m "test: failing test for sync miss resolver same-call return

Documents the bug where resolve() doesn't re-check registry after sync
miss resolver registers a handler. validate.ts:133 silently skips
validation for lazy types on first use because of this."
```

---

## Task 2: Apply the 3-line registry fix — re-check exact after sync miss notify

**Files:**
- Modify: `engine/core/src/core/registry.ts` lines 47-65 (the `resolve` function)

- [ ] **Step 1: Edit `resolve()` to re-check after notify**

Locate the existing `resolve` function in `engine/core/src/core/registry.ts`:

```ts
export function resolve<C extends string>(type: TypeId, context: C, _notifyMiss = true): ContextHandler<C> | null {
  validateContext(context);
  const n = normalizeType(type);
  const exact = registry.get(n)?.get(context);
  if (exact) return exact.handler as ContextHandler<C>;

  // Notify miss BEFORE default fallback — async loaders (UIX) start fetching,
  // register when done, bump triggers re-render → next resolve finds exact match.
  if (_notifyMiss) missResolvers.get(context)?.(n);

  const def = registry.get(DEFAULT_TYPE)?.get(context);
  if (def) return def.handler as ContextHandler<C>;

  // fallback: strip last segment ("react:compact" → "react")
  const sep = context.lastIndexOf(':');
  if (sep > 0) return resolve(type, context.slice(0, sep) as C, false);

  return null;
}
```

Replace the comment block + the `_notifyMiss` line with:

```ts
  // Notify miss BEFORE default fallback. Async loaders (UIX) start fetching, register
  // when done, bump() triggers re-render — next resolve() finds exact match. Sync
  // resolvers register inline; we re-check exact below so they take effect in this call.
  if (_notifyMiss) {
    missResolvers.get(context)?.(n);
    const reExact = registry.get(n)?.get(context);
    if (reExact) return reExact.handler as ContextHandler<C>;
  }
```

- [ ] **Step 2: Run the test from Task 1 — verify it now passes**

```bash
npm test -- --test-name-pattern="returns handler registered synchronously"
```

Expected: PASS.

- [ ] **Step 3: Run the entire core test suite — verify no regressions**

```bash
npm test --workspace=@treenx/core
```

Expected: all tests pass. If anything fails, the failure is the regression to investigate before proceeding.

- [ ] **Step 4: Commit the fix**

```bash
git add engine/core/src/core/registry.ts
git commit -m "fix(core): resolve() re-checks registry after sync miss resolver

Sync miss resolvers (e.g., lazy schema generation) register a handler
inline. Without the re-check, resolve() returned null on the first call,
causing validate.ts:133 to silently skip validation for lazy types.

Async resolvers (UIX-style fetch + bump) are unaffected — they continue
to register on a later tick and re-render via bump()."
```

---

## Task 3: Add test — async miss resolver still works (no regression on UIX-style pattern)

**Files:**
- Modify: `engine/core/src/core/index.test.ts` (append within the `describe('Lazy resolver semantics (sync miss)', ...)` block from Task 1)

- [ ] **Step 1: Write the test**

Inside the `describe('Lazy resolver semantics (sync miss)', () => { ... })` block, append:

```ts
  it('async miss resolver still uses bump+re-render path (returns null first call, handler after)', async () => {
    const snap = saveRegistrySnapshot();
    try {
      const TYPE = 'lazy.async.B';
      let resolved: (() => void) | null = null;
      const work = new Promise<void>((res) => { resolved = res; });

      onResolveMiss('schema', (type) => {
        if (type !== TYPE) return;
        // Simulate async fetch — register on next tick
        Promise.resolve().then(() => {
          register(type, 'schema', () => ({ $id: type, type: 'object' as const, title: 'B', properties: {} }));
          resolved!();
        });
      });

      const first = resolve(TYPE, 'schema');
      assert.equal(first, null, 'async path: first resolve returns null while resolver runs in background');

      await work;
      const second = resolve(TYPE, 'schema');
      assert.ok(second, 'async path: second resolve returns the handler registered in background');
    } finally {
      restoreRegistrySnapshot(snap);
    }
  });
```

- [ ] **Step 2: Run the test**

```bash
npm test -- --test-name-pattern="async miss resolver still uses bump"
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add engine/core/src/core/index.test.ts
git commit -m "test: async miss resolver semantics unchanged after re-check fix"
```

---

## Task 4: Add test — miss resolver that doesn't register falls through to default/null

**Files:**
- Modify: `engine/core/src/core/index.test.ts` (same `describe` block)

- [ ] **Step 1: Write the test**

Inside the `describe('Lazy resolver semantics (sync miss)', () => { ... })` block, append:

```ts
  it('miss resolver that does not register: resolve falls through to default/null', () => {
    const snap = saveRegistrySnapshot();
    try {
      const TYPE = 'lazy.noop.C';
      let invoked = 0;

      onResolveMiss('schema', (type) => {
        if (type !== TYPE) return;
        invoked++;
        // Deliberately do NOT register — simulate "not my prefix" early-return
      });

      const handler = resolve(TYPE, 'schema');
      assert.equal(invoked, 1, 'resolver was invoked');
      assert.equal(handler, null, 'no registration → resolve returns null');
    } finally {
      restoreRegistrySnapshot(snap);
    }
  });
```

- [ ] **Step 2: Run the test**

```bash
npm test -- --test-name-pattern="resolver that does not register"
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add engine/core/src/core/index.test.ts
git commit -m "test: noop sync miss resolver falls through correctly"
```

---

## Task 5: Add failing test — `replaceHandler` overrides an existing entry

**Files:**
- Modify: `engine/core/src/core/index.test.ts` (append a new top-level `describe` block at end of file)

- [ ] **Step 1: Write the failing test**

Append to the end of `engine/core/src/core/index.test.ts`:

```ts
describe('replaceHandler', () => {
  it('overrides an existing handler atomically', () => {
    const snap = saveRegistrySnapshot();
    try {
      const TYPE = 'replace.test.D';
      const first = () => 'first';
      const second = () => 'second';

      register(TYPE, 'schema', first as any);
      assert.equal((resolve(TYPE, 'schema') as any)?.(), 'first');

      // Plain register() must be a no-op (silent dedup)
      register(TYPE, 'schema', second as any);
      assert.equal((resolve(TYPE, 'schema') as any)?.(), 'first', 'plain register no-ops on duplicate');

      // replaceHandler must override
      replaceHandler(TYPE, 'schema', second as any);
      assert.equal((resolve(TYPE, 'schema') as any)?.(), 'second', 'replaceHandler overrides');
    } finally {
      restoreRegistrySnapshot(snap);
    }
  });

  it('registers cleanly when no prior entry exists', () => {
    const snap = saveRegistrySnapshot();
    try {
      const TYPE = 'replace.fresh.E';
      const handler = () => 'fresh';

      replaceHandler(TYPE, 'schema', handler as any);
      assert.equal((resolve(TYPE, 'schema') as any)?.(), 'fresh');
    } finally {
      restoreRegistrySnapshot(snap);
    }
  });

  it('preserves meta when replacing', () => {
    const snap = saveRegistrySnapshot();
    try {
      const TYPE = 'replace.meta.F';
      const handler = () => 'with-meta';

      replaceHandler(TYPE, 'schema', handler as any, { source: 'test' });
      const meta = getMeta(TYPE, 'schema');
      assert.deepEqual(meta, { source: 'test' });
    } finally {
      restoreRegistrySnapshot(snap);
    }
  });
});
```

Also extend the imports at the top of the file from line 5-19. Find this block:

```ts
import {
  createNode,
  getComponent,
  getComponents,
  isComponent,
  isRef,
  mapRegistry,
  ref,
  register,
  removeComponent,
  onResolveMiss,
  render,
  resolve,
  unregister,
} from './index';
```

Replace with:

```ts
import {
  createNode,
  getComponent,
  getComponents,
  getMeta,
  isComponent,
  isRef,
  mapRegistry,
  ref,
  register,
  removeComponent,
  onResolveMiss,
  render,
  replaceHandler,
  resolve,
  unregister,
} from './index';
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- --test-name-pattern="replaceHandler"
```

Expected: FAIL — TypeScript will error on the missing `replaceHandler` import (or at runtime: `replaceHandler is not a function`).

- [ ] **Step 3: Commit the failing test**

```bash
git add engine/core/src/core/index.test.ts
git commit -m "test: failing tests for replaceHandler API"
```

---

## Task 6: Implement `replaceHandler` in `registry.ts`

**Files:**
- Modify: `engine/core/src/core/registry.ts` — append after the existing `unregister` function (line 78-87)

- [ ] **Step 1: Add the implementation**

In `engine/core/src/core/registry.ts`, locate the existing `unregister` function:

```ts
export function unregister(type: string, context: string): boolean {
  validateContext(context);
  const t = normalizeType(type);
  const inner = registry.get(t);
  if (!inner?.has(context)) return false;
  inner.delete(context);
  if (!inner.size) registry.delete(t);
  bump();
  return true;
}
```

Immediately after it, add:

```ts
/** Atomic replace: unregister(type, ctx) if present, then register. Use this when a
 *  caller must override an existing handler (HMR-style hot reload, inheritance
 *  fallback override). Plain register() keeps its silent-dedup contract for
 *  module-load idempotency. */
export function replaceHandler<C extends string>(type: string, context: C, handler: ContextHandler<C>, meta?: Record<string, unknown>): void;
export function replaceHandler<T, C extends string>(type: Class<T>, context: C, handler: ContextHandler<C, T>, meta?: Record<string, unknown>): void;
export function replaceHandler(type: TypeId, context: string, handler: Handler, meta?: Record<string, unknown>): void {
  unregister(normalizeType(type), context);
  register(type as any, context, handler as any, meta);
}
```

- [ ] **Step 2: Run the failing tests — verify they now pass**

```bash
npm test -- --test-name-pattern="replaceHandler"
```

Expected: all three `replaceHandler` tests PASS.

- [ ] **Step 3: Run the entire core test suite — verify no regressions**

```bash
npm run typecheck && npm test --workspace=@treenx/core
```

Expected: typecheck passes, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add engine/core/src/core/registry.ts
git commit -m "feat(core): add replaceHandler for atomic unregister+register

Plain register() silently dedups on duplicate (type, context) — required
for HMR safety when modules re-execute. replaceHandler is the explicit
escape hatch for callers that must override: HMR-style hot reload,
inheritance fallback overrides, hot type re-pack.

Two-overload signature mirrors register(): string TypeId or Class TypeId.
Forwards meta unchanged."
```

---

## Task 7: Final verification — typecheck and full project test run

**Files:** none modified.

- [ ] **Step 1: Typecheck the three tsconfigs**

```bash
npm run typecheck
```

Expected: zero errors across engine/core, engine/packages/react, root.

- [ ] **Step 2: Full test run**

```bash
npm test
```

Expected: all suites green. The new `Lazy resolver semantics (sync miss)` and `replaceHandler` describe blocks should appear in the output.

- [ ] **Step 3: Confirm git log shows the four commits in order**

```bash
git log --oneline -n 10
```

Expected most-recent-first:
1. `feat(core): add replaceHandler for atomic unregister+register`
2. `test: failing tests for replaceHandler API`
3. `test: noop sync miss resolver falls through correctly`
4. `test: async miss resolver semantics unchanged after re-check fix`
5. `fix(core): resolve() re-checks registry after sync miss resolver`
6. `test: failing test for sync miss resolver same-call return`

- [ ] **Step 4: No extra commit — summary only**

This task does not create a commit. If verification reveals an issue, fix it inline and amend or add a follow-up commit before declaring the plan complete.

---

## Acceptance criteria coverage

| AC (from AUTO_REVIEW_JSONLD_TYPES.md) | Task |
|---|---|
| **AC14** — exact view replaces inherited fallback via `replaceHandler` | Tasks 5–6 (general primitive; UIX wiring lands in the inheritance plan) |
| **AC17 (revised)** — plain `register()` is documented no-op on duplicate; `replaceHandler` overrides | Task 5 (test asserts both behaviours) |
| **AC21** — sync-lazy schema resolves correctly on first `validateNode` call | Tasks 1–4 (test + fix + regression coverage) |

## What this plan deliberately does NOT cover

- `t.mount.jsonld` adapter — separate plan after these foundations are green.
- `addTypeValidator('jsonld.refOrComponent', ...)` — separate plan.
- Vendored schema.org snapshot, override files, `loadSchemaOrgV29Pack` — separate plan.
- UIX inheritance walker (uses `replaceHandler` from this plan) — separate plan.
- Round-trip exporter/importer — separate plan.
- `mods/ontology` migration — final plan in the sequence.

These are intentionally deferred so this PR is reviewable in isolation: ~10 LoC of core changes plus their tests, no behavioural change for any existing caller.
