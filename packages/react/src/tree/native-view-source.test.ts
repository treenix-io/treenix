import { createNativeTreeSource, type NativeMount, type NativeSnapshot } from '#tree/native-source'
import { act, fireEvent, render, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { useNativeChildren } from '#tree/native-hooks'
import { NativeSourceProvider } from '#tree/native-source-context'
import { KernelError } from '@treenx/core/errors'
import { NativeTreeBrowser } from '#native/NativeEditor'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { it, type TestContext } from 'node:test'
import { createTwpClient } from '@treenx/core/client/twp'
import { createMemoryBlobStore } from '../../../../core/src/kernel/blob-store-memory'
import { createInstance } from '../../../../core/src/kernel/instance'
import { drainSession } from '../../../../core/src/kernel/session-delivery'
import { createMemoryStore } from '../../../../core/src/kernel/store/memory'
import { createTwpServing } from '../../../../core/src/protocol/serve'
import { A, R, type Connection, type DeriveHandler, type Frame, type ModuleManifest, type Position, type Preconditions, type Request } from '@treenx/core/kernel/types'

/** Observes native delivery without polling or delaying the producer. */
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('Observer is absent') }
  const promise = new Promise<T>(ready => { resolve = ready })
  return { promise, resolve }
}

/** Opens a real instance, Session serving connection, and client with explicit View-node grants. */
async function fixture(t: TestContext, derive: DeriveHandler, executor: 'node' | 'reader' = 'node', beforeDelivery?: (frame: Frame) => Promise<void>, restricted = false) {
  const id = randomUUID()
  const store = createMemoryStore({ domain: id })
  let saved: Position | undefined
  const module: ModuleManifest = {
    id: 'views',
    types: [{ name: 'example.view', module: 'views', version: 0,
      security: 'privileged-capability', schema: { type: 'object', properties: { pattern: { type: 'string' } } }, actions: {} },
      { name: 'example.record', module: 'views', version: 0, security: 'ordinary', schema: {}, actions: {} }],
    security: [{ type: 'example.view', context: 'mount', async handler() {
      return executor === 'node'
        ? { kind: 'view', executor: 'node', derive, async close() {} }
        : { kind: 'view', executor: 'reader', derive, async close() {} }
    } }],
    open: [],
  }
  const instance = await createInstance({ id, root: { kind: 'store', store }, modules: [module], blobs: createMemoryBlobStore(),
    provisioning: { writerEpoch: 1, domains: [{ store, epoch: randomUUID(), persistent: false }],
      credentialTtlMs: 60_000, counter: { async load() { return saved }, async save(pos) { saved = pos },
        async freshEpoch(floor) { return floor + 1 } },
      bootstrap: { kind: 'fresh', admin: { path: '/admin', name: 'admin', password: randomUUID() } } } })
  assert.ok(instance.setupCredential)
  let credential = instance.setupCredential
  const admin = await instance.openSession(credential)
  const draining = drainSession(admin)
  const serving = createTwpServing(instance)
  t.after(async () => { serving.close(); await instance.close(); await draining })
  const commit = (changes: Parameters<typeof admin.commit>[0]['changes'], expect?: Preconditions) => admin.commit({
    opId: { epoch: instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() }, changes, expect,
  }).outcome
  await commit([
    { op: 'put', node: { $path: '/source', $type: 't.dir' } },
    { op: 'put', node: { $path: '/source/a', $type: 't.dir', value: 1, friend: '/source/b', $owner: admin.actor.principal, $acl: [] } },
    { op: 'put', node: { $path: '/source/b', $type: 't.dir', value: 2 } },
    { op: 'put', node: { $path: '/view', $type: 't.dir', '#mount': { $type: 'example.view', pattern: 'result' } } },
  ])
  if (executor === 'node') {
    const declaration = (await admin.read({ node: '/view' })).copies[0]
    assert.ok(declaration !== undefined && 'node' in declaration)
    await commit([{ op: 'patch', path: '/source', ops: { $set: {
      $acl: [{ subject: { group: `n:${declaration.node.$id}` }, grant: R | A }],
    } } }], { nodes: [{ path: declaration.node.$path, rev: declaration.node.$rev }] })
  }
  let recipientPrincipal = admin.actor.principal
  const opened = await serving.open({ t: 'hi' }, restricted ? undefined : credential, '127.0.0.1')
  if (restricted) {
    assert.ok(opened.credential)
    credential = opened.credential
    const recipient = await instance.openSession(credential)
    recipientPrincipal = recipient.actor.principal
    await commit([{ op: 'patch', path: '/view', ops: { $set: { $acl: [{ subject: { group: recipient.actor.principal }, grant: R }] } } }])
    recipient.close()
  }
  const attached = serving.attach(opened.id, credential, '127.0.0.1')
  const sent: Request[] = []
  const seen: Frame[] = []
  const connection: Connection = { frames: {
    async *[Symbol.asyncIterator]() {
      for await (const frame of attached.frames) { await beforeDelivery?.(frame); seen.push(frame); yield frame }
    },
  }, send(request) {
    sent.push(request)
    serving.dispatch(opened.id, credential, '127.0.0.1', [request])
  } }
  const client = createTwpClient(connection, { close: attached.close, credential })
  t.after(() => client.close())
  await client.ready
  const source = createNativeTreeSource(client)
  t.after(() => source.close())
  const wrapper = ({ children }: { children: ReactNode }) => createElement(NativeSourceProvider, { source, children })
  return { client, source, sent, seen, commit, credential, wrapper, instance, module, owner: admin.actor.principal, recipientPrincipal }
}

/** Waits for a published adapter snapshot while preserving its mount ownership. */
function changed(handle: NativeMount, check: (snapshot: NativeSnapshot) => boolean): Promise<NativeSnapshot> {
  const current = handle.getSnapshot()
  if (check(current)) return Promise.resolve(current)
  return new Promise(resolve => {
    const unsubscribe = handle.subscribe(() => {
      const snapshot = handle.getSnapshot()
      if (check(snapshot)) { unsubscribe(); resolve(snapshot) }
    })
  })
}

it('exposes live computed deltas and replacing rows through the genuine native React hook', { timeout: 10_000 }, async t => {
  const f = await fixture(t, async (_node, _request, read) => {
    const result = await read.read({ children: '/source' })
    const root = (await read.read({ node: '/source' })).copies[0]
    assert.ok(root && 'node' in root)
    return { members: result.copies.map(copy => {
      assert.ok('node' in copy)
      return copy.node.$path
    }), rows: root.node.mode === 'empty' ? [] : [{ key: root.node.mode === 'total' ? 'total' : 'count', value: result.list.length }] }
  })
  const handle = f.source.mount({ children: '/view/result', sort: [['value', 1]] })
  const hook = renderHook(() => useNativeChildren('/view/result', { sort: [['value', 1]] }), { wrapper: f.wrapper })
  t.after(() => { act(() => hook.unmount()) })
  await act(async () => { await changed(handle, snapshot => snapshot.phase === 'ready') })
  const snapshot = hook.result.current
  assert.deepEqual(snapshot.members, [])
  assert.deepEqual(snapshot.computed?.map(node => node.value), [1, 2])
  assert.deepEqual(snapshot.rows, [{ key: 'count', value: 2 }])
  assert.deepEqual(f.client.cache.claims(), [])
  await act(async () => {
    await f.commit([{ op: 'patch', path: '/source/b', ops: { $set: { value: 0 } } }])
    await changed(handle, snapshot => snapshot.computed?.[0]?.value === 0)
  })
  assert.deepEqual(hook.result.current.computed?.map(node => node.value), [0, 1])
  await act(async () => {
    await f.commit([{ op: 'patch', path: '/source', ops: { $set: { mode: 'total' } } }])
    await changed(handle, snapshot => snapshot.rows?.[0]?.key === 'total')
  })
  assert.deepEqual(hook.result.current.rows, [{ key: 'total', value: 2 }])
  await act(async () => {
    await f.commit([{ op: 'patch', path: '/source', ops: { $set: { mode: 'empty' } } }])
    await changed(handle, snapshot => snapshot.rows?.length === 0)
  })
  assert.deepEqual(hook.result.current.rows, [])
  const stable = hook.result.current
  await act(async () => { await f.commit([{ op: 'put', node: { $path: '/unrelated', $type: 't.dir' } }]) })
  assert.equal(hook.result.current, stable)
  assert.equal(f.sent.some(request => request.t === 'read'), false)
  act(() => hook.unmount())
  handle.dispose()
  assert.equal(handle.getSnapshot().error?.code, 'CANCELLED')
  assert.equal(handle.getSnapshot().computed, undefined)
  assert.equal(handle.getSnapshot().rows, undefined)
})

it('keeps computed includes separate from later direct cursor members and preserves duplicate row keys per page', { timeout: 10_000 }, async t => {
  const held = deferred<void>(), release = deferred<void>()
  t.after(() => release.resolve())
  let pause = false, first: string | undefined
  const f = await fixture(t, async (_node, _request, read) => {
    const result = await read.read({ children: '/source' })
    const root = (await read.read({ node: '/source' })).copies[0]
    assert.ok(root && 'node' in root)
    return { members: result.copies.map(copy => {
      assert.ok('node' in copy)
      return copy.node.$path
    }), rows: root.node.empty === true ? [] : [{ key: 'count', value: result.list.length }] }
  }, 'node', async frame => {
    if (!pause || frame.t !== 'result' || frame.rows?.length !== 0) return
    if (first === undefined) first = frame.sub
    else { pause = false; held.resolve(); await release.promise }
  })
  const handle = f.source.mount({ children: '/view/result', sort: [['value', 1]], window: { limit: 1 }, include: [{ ref: 'friend' }] })
  const firstPage = await changed(handle, snapshot => snapshot.phase === 'ready')
  assert.deepEqual(firstPage.computed?.map(node => node.value), [1])
  assert.deepEqual(firstPage.computedIncluded?.map(node => node.value), [2])
  assert.ok(firstPage.next)
  handle.loadMore()
  const both = await changed(handle, snapshot => snapshot.phase === 'ready' && snapshot.computed?.length === 2)
  assert.deepEqual(both.computed?.map(node => node.value), [1, 2])
  assert.deepEqual(both.computedIncluded, [])
  assert.deepEqual(both.rows, [{ key: 'count', value: 2 }, { key: 'count', value: 2 }])
  pause = true
  const oneEmpty = changed(handle, snapshot => snapshot.phase === 'ready' && snapshot.rows?.length === 1)
  await f.commit([{ op: 'patch', path: '/source', ops: { $set: { empty: true } } }])
  await held.promise
  assert.deepEqual((await oneEmpty).rows, [{ key: 'count', value: 2 }])
  const allEmpty = changed(handle, snapshot => snapshot.rows?.length === 0)
  release.resolve()
  assert.deepEqual((await allEmpty).rows, [])
  const updated = changed(handle, snapshot => snapshot.computed?.[1]?.label === 'updated')
  await f.commit([{ op: 'patch', path: '/source/b', ops: { $set: { label: 'updated' } } }])
  assert.deepEqual((await updated).computed?.map(node => node.value), [1, 2])
  const ordinary = f.source.mount({ node: '/source/b' })
  const readable = await changed(ordinary, snapshot => snapshot.phase === 'ready')
  assert.equal(readable.members.length, 1)
  assert.equal(readable.computed, undefined)
  const ordinarySub = f.sent.find(request => request.t === 'sub' && 'node' in request.selector && request.selector.node === '/source/b')
  assert.ok(ordinarySub)
  handle.dispose()
  assert.equal(ordinary.getSnapshot(), readable)
  ordinary.dispose()
})

it('orders live page ownership by caller priority and refuses absent owned computed data', { timeout: 10_000 }, async t => {
  const f = await fixture(t, async (_node, _request, read) => {
    const source = (await read.read({ node: '/source/a' })).copies[0]
    assert.ok(source && 'node' in source)
    return { members: [source.node.$path] }
  })
  const first = f.client.sub({ children: '/view/result' }, () => {})
  const second = f.client.sub({ children: '/view/result' }, () => {})
  await Promise.all([first.ready, second.ready])
  assert.deepEqual(f.client.cache.orderedComputed([first.id, second.id], []), f.client.cache.orderedComputed(first.id, []))
  first.close()
  assert.deepEqual(f.client.cache.orderedComputed([second.id], []), f.client.cache.list(second.id)?.computed)
  assert.throws(() => f.client.cache.orderedComputed([first.id, second.id], []), error => error instanceof KernelError && error.code === 'INVALID')
  second.close()
})

it('clears computed output at a real target reset and keeps disposed handles empty', { timeout: 10_000 }, async t => {
  const held = deferred<void>(), release = deferred<void>()
  t.after(() => release.resolve())
  let pause = false
  const f = await fixture(t, async (_node, _request, read) => {
    const source = (await read.read({ node: '/source/a' })).copies[0]
    assert.ok(source && 'node' in source)
    return { members: [source.node.$path], rows: [{ key: 'value', value: source.node.value }] }
  }, 'node', async frame => {
    if (pause && frame.t === 'snap' && frame.gen > 1) { pause = false; held.resolve(); await release.promise }
  })
  const handle = f.source.mount({ children: '/view/result' })
  const initial = await changed(handle, snapshot => snapshot.phase === 'ready')
  assert.equal(initial.computed?.length, 1)
  assert.deepEqual(initial.rows, [{ key: 'value', value: 1 }])
  pause = true
  const reset = changed(handle, snapshot => snapshot.phase === 'loading')
  await f.commit([{ op: 'patch', path: '/view', ops: { $set: { '#mount.pattern': 'replacement' } } }])
  await held.promise
  const loading = await reset
  assert.equal(loading.computed, undefined)
  assert.equal(loading.rows, undefined)
  assert.deepEqual(loading.members, [])
  handle.dispose()
  release.resolve()
  assert.equal(handle.getSnapshot().computed, undefined)
  assert.equal(handle.getSnapshot().rows, undefined)
  const replacement = f.source.mount({ children: '/view/result' })
  const ready = await changed(replacement, snapshot => snapshot.phase === 'ready')
  assert.deepEqual(ready.members, [])
  assert.equal(ready.computed, undefined)
  assert.equal(ready.rows, undefined)
  replacement.dispose()
})

it('publishes a paused reader run through the adapter while a separate ordinary subscription stays newer', { timeout: 10_000 }, async t => {
  const captured = deferred<void>(), resume = deferred<void>()
  t.after(() => resume.resolve())
  let runs = 0
  const f = await fixture(t, async (_node, _request, read) => {
    const source = (await read.read({ node: '/source/a' })).copies[0]
    assert.ok(source && 'node' in source)
    const run = ++runs
    if (run === 2) { captured.resolve(); await resume.promise }
    return { members: [source.node.$path], rows: [{ key: 'value', value: source.node.value }, { key: 'run', value: run }] }
  }, 'reader')
  const ordinaryUpdated = deferred<void>()
  const ordinary = f.client.sub({ node: '/source/a' }, () => {
    const copy = f.client.cache.at('/source/a')
    assert.ok(copy && 'node' in copy)
    if (copy.node.value === 2) ordinaryUpdated.resolve()
  })
  await ordinary.ready
  const handle = f.source.mount({ children: '/view/result' })
  await changed(handle, snapshot => snapshot.phase === 'ready')
  await f.commit([{ op: 'patch', path: '/source/a', ops: { $set: { wake: true } } }])
  await captured.promise
  await f.commit([{ op: 'patch', path: '/source/a', ops: { $set: { value: 2 } } }])
  await ordinaryUpdated.promise
  const old = changed(handle, snapshot => snapshot.rows?.some(row => row.key === 'run' && row.value === 2) === true)
  resume.resolve()
  const oldResult = await old
  const copy = oldResult.members[0]
  assert.ok(copy && 'node' in copy)
  assert.equal(copy.node.value, 2)
  assert.deepEqual(oldResult.rows, [{ key: 'value', value: 1 }, { key: 'run', value: 2 }])
  const final = await changed(handle, snapshot => snapshot.rows?.some(row => row.key === 'run' && row.value === 3) === true)
  assert.deepEqual(final.rows, [{ key: 'value', value: 2 }, { key: 'run', value: 3 }])
  const converged = final.members[0]
  assert.ok(converged && 'node' in converged)
  assert.equal(converged.node.value, 2)
  assert.equal(f.sent.some(request => request.t === 'read'), false)
  handle.dispose()
  ordinary.close()
})

it('renders ordered mixed View output read-only without subscribing to selected computed source paths', { timeout: 10_000 }, async t => {
  const f = await fixture(t, async (_node, _request, read) => {
    const result = await read.read({ children: '/source' })
    return { members: result.copies.map(copy => 'node' in copy ? copy.node.$path : copy.path), rows: [{ key: 'count', value: result.list.length }] }
  })
  await f.commit([
    { op: 'remove', path: '/source/b' },
    { op: 'put', node: { $path: '/source/b', $type: 'example.record', value: 'invalid', $owner: f.owner, $acl: [] } },
  ])
  f.instance.registry.publish({ ...f.module, types: f.module.types.map(type => type.name === 'example.record'
    ? { ...type, schema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] } }
    : type) })
  const ordered = f.source.mount({ children: '/view/result', sort: [['value', -1]] })
  const mixed = await changed(ordered, snapshot => snapshot.phase === 'ready')
  assert.deepEqual(mixed.output?.map(member => member.kind), ['copy', 'computed'])
  assert.deepEqual(mixed.members, [])
  assert.equal(mixed.viewErrors?.[0].error.code, 'INVALID')
  assert.equal(f.client.cache.at('/source/b'), undefined)
  assert.equal(f.client.cache.claims().some(claim => claim.id === mixed.viewErrors?.[0].id), false)
  assert.equal(mixed.computed?.length, 1)
  const root = f.source.mount({ node: '/' })
  const browser = render(createElement(NativeTreeBrowser), { wrapper: f.wrapper })
  t.after(() => { act(() => browser.unmount()) })
  await act(async () => { await changed(root, snapshot => snapshot.phase === 'ready') })
  assert.ok(browser.getByLabelText('Данные узла'))
  const visible = f.source.mount({ children: '/view/result', window: { limit: 100 } })
  await act(async () => {
    fireEvent.change(browser.getByLabelText('Адрес'), { target: { value: '/view/result' } })
    fireEvent.click(browser.getByText('Открыть'))
    await changed(visible, snapshot => snapshot.phase === 'ready')
  })
  assert.ok(browser.getByLabelText('Результат View'))
  assert.deepEqual(ordered.getSnapshot().output?.map(member => member.kind), ['copy', 'computed'])
  assert.ok(browser.getByLabelText('Строки View').textContent?.includes('count'))
  assert.equal(browser.queryByLabelText('Данные узла'), null)
  act(() => { fireEvent.click(browser.getByRole('button', { name: '/source/b: INVALID' })) })
  assert.ok(browser.getByRole('alert').textContent?.includes('INVALID'))
  act(() => { fireEvent.click(browser.getByRole('button', { name: '/source/a' })) })
  assert.ok(browser.getByLabelText('Данные View').textContent?.includes('"value": 1'))
  assert.equal(f.sent.some(request => request.t === 'sub' && 'node' in request.selector
    && (request.selector.node === '/source/a' || request.selector.node === '/source/b')), false)
  assert.equal(f.sent.some(request => request.t === 'read'), false)
  act(() => browser.unmount())
  const ordinary = f.source.mount({ children: '/source', sort: [['$owner', 1]] })
  const independent = await changed(ordinary, snapshot => snapshot.phase === 'ready')
  const ordinaryError = independent.members.find(copy => 'error' in copy)
  assert.ok(ordinaryError && 'error' in ordinaryError)
  assert.equal(ordinaryError.sort?.$owner, f.owner)
  assert.equal(ordered.getSnapshot().viewErrors?.[0].sort?.$owner, undefined)
  assert.equal(f.client.cache.copy(ordinaryError.id), ordinaryError)
  const recovered = changed(ordered, snapshot => snapshot.viewErrors?.length === 0 && snapshot.computed?.length === 2)
  await f.commit([{ op: 'patch', path: '/source/b', ops: { $set: { value: 3 } } }])
  const valid = await recovered
  assert.deepEqual(valid.computed?.map(node => node.value), [3, 1])
  assert.deepEqual(valid.viewErrors, [])
  const current = f.client.cache.at('/source/b')
  assert.ok(current && 'node' in current)
  assert.equal(current.node.value, 3)
  ordinary.dispose()
  ordered.dispose()
  root.dispose()
  visible.dispose()
})


it('keeps node View errors owned when the actual recipient has View R and no source R', { timeout: 10_000 }, async t => {
  const f = await fixture(t, async (_node, _request, read) => {
    const result = await read.read({ children: '/source' })
    return { members: result.copies.map(copy => 'node' in copy ? copy.node.$path : copy.path) }
  }, 'node', undefined, true)
  await f.commit([{ op: 'remove', path: '/source/b' },
    { op: 'put', node: { $path: '/source/b', $type: 'example.record', value: 'invalid', $owner: f.owner, $acl: [] } }])
  f.instance.registry.publish({ ...f.module, types: f.module.types.map(type => type.name === 'example.record'
    ? { ...type, schema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] } } : type) })
  const handle = f.source.mount({ children: '/view/result', sort: [['$owner', 1], ['$acl', 1]] })
  const snapshot = await changed(handle, result => result.phase === 'ready')
  assert.equal(snapshot.computed?.length, 1)
  assert.equal(snapshot.viewErrors?.length, 1)
  assert.deepEqual(snapshot.members, [])
  assert.equal(snapshot.viewErrors[0].sort?.$owner, undefined)
  assert.equal(snapshot.viewErrors[0].sort?.$acl, undefined)
  assert.equal(f.client.cache.at('/source/b'), undefined)
  assert.deepEqual(f.client.cache.claims(), [])
  const pages = f.source.mount({ children: '/view/result', sort: [['value', 1]], window: { limit: 1 }, include: [{ ref: 'friend' }] })
  const first = await changed(pages, result => result.phase === 'ready')
  assert.equal(first.computed?.length, 1)
  assert.deepEqual(first.viewErrors, [])
  assert.equal(first.viewErrorsIncluded?.[0].id, snapshot.viewErrors[0].id)
  assert.ok(first.next)
  const expanded = changed(pages, result => result.generations.length === 2 && result.phase === 'ready')
  pages.loadMore()
  const two = await expanded
  assert.deepEqual(two.output?.map(member => member.kind), ['computed', 'copy'])
  assert.equal(two.viewErrors?.[0].id, snapshot.viewErrors[0].id)
  assert.deepEqual(two.viewErrorsIncluded, [])
  pages.dispose()
  await assert.rejects(f.client.read({ node: '/source/b' }), (error: unknown) => error instanceof KernelError && error.code === 'NOT_FOUND')
  handle.dispose()
})


it('publishes a captured reader View error after source revoke without borrowing an ordinary error', { timeout: 10_000 }, async t => {
  const captured = deferred<void>(), resume = deferred<void>(), rerun = deferred<void>()
  t.after(() => { resume.resolve(); rerun.resolve() })
  let runs = 0
  const f = await fixture(t, async (_node, _request, read) => {
    const result = await read.read({ children: '/source' })
    const run = ++runs
    if (run === 1) { captured.resolve(); await resume.promise }
    if (run === 2) await rerun.promise
    return { members: result.copies.map(copy => 'node' in copy ? copy.node.$path : copy.path), rows: [{ key: 'run', value: run }] }
  }, 'reader', undefined, true)
  await f.commit([{ op: 'patch', path: '/source', ops: { $set: { $acl: [{ subject: { group: f.recipientPrincipal }, grant: R }] } } },
    { op: 'remove', path: '/source/b' }, { op: 'put', node: { $path: '/source/b', $type: 'example.record', value: 'invalid' } }])
  f.instance.registry.publish({ ...f.module, types: f.module.types.map(type => type.name === 'example.record'
    ? { ...type, schema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] } } : type) })
  const handle = f.source.mount({ children: '/view/result' })
  await captured.promise
  await f.commit([{ op: 'patch', path: '/source', ops: { $set: { $acl: [] } } }])
  const old = changed(handle, snapshot => snapshot.rows?.[0].value === 1)
  resume.resolve()
  const published = await old
  assert.equal(published.viewErrors?.[0].error.code, 'INVALID')
  assert.equal(f.client.cache.at('/source/b'), undefined)
  assert.equal(f.client.cache.claims().some(claim => claim.id === published.viewErrors?.[0].id), false)
  const fresh = changed(handle, snapshot => snapshot.rows?.[0].value === 2)
  rerun.resolve()
  const converged = await fresh
  assert.deepEqual(converged.members, [])
  assert.deepEqual(converged.viewErrors, [])
  assert.deepEqual(converged.output, [])
  handle.dispose()
})
