import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { createTwpClient } from '@treenx/core/client/twp'
import { KernelError } from '@treenx/core/errors'
import type { Connection, Position, Request, SubSelector } from '@treenx/core/kernel/types'
import { createInstanceFoundation } from '../../../../core/src/kernel/instance'
import { createNodeLane } from '../../../../core/src/kernel/lane'
import { createMemoryStore } from '../../../../core/src/kernel/store/memory'
import { useNativeChildren, useNativeNode } from '#tree/native-hooks'
import { createNativeTreeSource, type NativeSnapshot, type NativeTreeSource } from '#tree/native-source'
import { NativeSourceProvider } from '#tree/native-source-context'
import { NativeTreeBrowser } from '#native/NativeEditor'

async function fixture(id: string) {
  const root = createMemoryStore({ domain: id })
  let saved: Position | undefined, sequence = 0
  const instance = await createInstanceFoundation({ id, root, writerEpoch: 1,
    counter: { async load() { return saved }, async save(pos) { saved = pos }, async freshEpoch(floor) { return floor + 1 } },
    domains: [{ store: root, epoch: `${id}:memory`, persistent: false }],
    firstAdmin: { path: '/admin', name: 'admin', password: 'react-source-password' }, initialCredential: { ttlMs: 60_000 } })
  assert.ok(instance.setupCredential)
  const admin = instance.commands(await instance.auth.openCredential(instance.setupCredential))
  const key = () => ({ epoch: instance.writer.intake.epoch, time: Date.now(), nonce: String(++sequence) })
  await admin.commit({ opId: key(), changes: [
    { op: 'put', node: { $path: '/item', $type: 't.dir', value: 1 } },
    { op: 'put', node: { $path: '/other', $type: 't.dir', value: 2 } },
  ] })
  const lane = createNodeLane(instance.nodeLaneOptions(await instance.auth.openCredential(instance.setupCredential))), sent: Request[] = []
  const connection: Connection = { frames: lane.frames, send(request) {
    sent.push(request)
    if (request.t === 'hi') throw new KernelError('UNAVAILABLE', 'The admitted loopback is already open')
    if (request.t === 'read') {
      if ('history' in request.selector) throw new KernelError('UNAVAILABLE', 'History reads are unavailable on this lane')
      lane.accept({ t: 'read', req: request.req, selector: request.selector })
      return
    }
    lane.accept(request)
  } }
  const client = createTwpClient(connection, { close: () => lane.close() })
  await client.ready
  const source = createNativeTreeSource(client)
  return { client, source, sent, admin, key, wrapper: ({ children }: { children: ReactNode }) => createElement(NativeSourceProvider, { source, children }),
    close() { cleanup(); source.close(); client.close(); admin.close(); instance.auth.close() } }
}
function until(source: NativeTreeSource, selector: SubSelector, predicate: (snapshot: NativeSnapshot) => boolean): Promise<void> {
  if (predicate(source.getSnapshot(selector))) return Promise.resolve()
  return new Promise(resolve => {
    const unsubscribe = source.subscribe(selector, () => {
      if (predicate(source.getSnapshot(selector))) { unsubscribe(); resolve() }
    })
  })
}
function textarea(element: HTMLElement): HTMLTextAreaElement {
  assert.ok(element instanceof window.HTMLTextAreaElement)
  return element
}

describe('native React hooks over an actual admitted kernel lane', { timeout: 10_000 }, () => {
  it('appends actual cursor pages and preserves included copies through live membership updates', async t => {
    const f = await fixture('react-children'); t.after(f.close)
    await f.admin.commit({ opId: f.key(), changes: [
      { op: 'put', node: { $path: '/items', $type: 't.dir' } },
      { op: 'put', node: { $path: '/items/a', $type: 't.dir', $order: 'A', friend: '/other' } },
      { op: 'put', node: { $path: '/items/b', $type: 't.dir', $order: 'B' } },
    ] })
    const selector: SubSelector = { children: '/items', window: { limit: 1 }, include: [{ ref: 'friend' }] }
    const hook = renderHook(() => useNativeChildren('/items', { window: { limit: 1 }, include: [{ ref: 'friend' }] }), { wrapper: f.wrapper })
    await act(async () => { await until(f.source, selector, snapshot => snapshot.phase === 'ready') })
    assert.equal(hook.result.current.members.length, 1); assert.ok(hook.result.current.next)
    const included = hook.result.current.included[0]; assert.ok('node' in included); assert.equal(included.node.$path, '/other')
    await act(async () => {
      hook.result.current.loadMore()
      await until(f.source, selector, snapshot => snapshot.phase === 'ready' && snapshot.members.length === 2)
    })
    assert.deepEqual(hook.result.current.members.map(copy => 'node' in copy ? copy.node.$path : copy.path), ['/items/a', '/items/b'])
    assert.equal(hook.result.current.next, undefined)
    await act(async () => {
      await f.source.commit({ changes: [{ op: 'patch', path: '/other', ops: { $set: { value: 5 } } }] }).outcome
      await until(f.source, selector, snapshot => snapshot.included[0]?.ver !== included.ver)
    })
    const updated = hook.result.current.included[0]; assert.ok('node' in updated); assert.equal(updated.node.value, 5)
    assert.equal(f.sent.some(request => request.t === 'read'), false)
    hook.unmount(); assert.deepEqual(f.source.getSnapshot(selector).included, [])
  })

  it('keeps path drafts local until validation and shows a live node removal', async t => {
    const f = await fixture('react-browser'); t.after(f.close)
    const browser = render(createElement(NativeTreeBrowser), { wrapper: f.wrapper })
    await act(async () => { await until(f.source, { children: '/', window: { limit: 100 } }, snapshot => snapshot.phase === 'ready') })
    const before = f.sent.length
    fireEvent.change(browser.getByLabelText('Адрес'), { target: { value: '' } })
    assert.equal(f.sent.length, before)
    fireEvent.click(browser.getByRole('button', { name: 'Открыть' }))
    assert.equal(f.sent.length, before)
    assert.equal(browser.getByRole('alert').textContent?.startsWith('INVALID:'), true)
    fireEvent.change(browser.getByLabelText('Адрес'), { target: { value: '/item' } })
    fireEvent.click(browser.getByRole('button', { name: 'Открыть' }))
    await act(async () => { await until(f.source, { node: '/item' }, snapshot => snapshot.phase === 'ready') })
    assert.equal(browser.queryByRole('alert'), null)
    assert.equal(browser.getByLabelText('Текущее состояние').textContent?.includes('"value": 1'), true)
    await act(async () => {
      await f.admin.commit({ opId: f.key(), changes: [{ op: 'remove', path: '/item' }] })
      await until(f.source, { node: '/item' }, snapshot => snapshot.phase === 'ready' && snapshot.members.length === 0)
    })
    assert.equal(browser.getByRole('status').textContent, 'Узел отсутствует')
  })

  it('owns editable drafts and action inputs by the selected node across repeated navigation', async t => {
    const f = await fixture('react-drafts'); t.after(f.close)
    const browser = render(createElement(NativeTreeBrowser), { wrapper: f.wrapper })
    await act(async () => { await until(f.source, { node: '/' }, snapshot => snapshot.phase === 'ready') })
    const rootDraft = textarea(browser.getByLabelText('Данные узла')).value
    fireEvent.change(browser.getByLabelText('Данные узла'), { target: { value: rootDraft.replace('"/"', '"/unsaved-root"') } })
    fireEvent.change(browser.getByLabelText('Действие'), { target: { value: 'root-only' } })
    fireEvent.change(browser.getByLabelText('Аргументы JSON'), { target: { value: '{"root":true}' } })
    fireEvent.change(browser.getByLabelText('Адрес'), { target: { value: '/item' } })
    fireEvent.click(browser.getByRole('button', { name: 'Открыть' }))
    await act(async () => { await until(f.source, { node: '/item' }, snapshot => snapshot.phase === 'ready') })
    const actionInput = browser.getByLabelText('Действие')
    assert.ok(actionInput instanceof window.HTMLInputElement)
    assert.equal(actionInput.value, '')
    assert.equal(textarea(browser.getByLabelText('Аргументы JSON')).value, '{}')
    assert.equal(JSON.parse(textarea(browser.getByLabelText('Данные узла')).value).$path, '/item')
    fireEvent.change(browser.getByLabelText('Данные узла'), { target: { value: '{"$path":"/item","$type":"t.dir","value":99}' } })
    fireEvent.change(browser.getByLabelText('Адрес'), { target: { value: '/' } })
    fireEvent.click(browser.getByRole('button', { name: 'Открыть' }))
    await act(async () => { await until(f.source, { node: '/' }, snapshot => snapshot.phase === 'ready') })
    assert.equal(JSON.parse(textarea(browser.getByLabelText('Данные узла')).value).$path, '/')
    fireEvent.change(browser.getByLabelText('Адрес'), { target: { value: '/item' } })
    fireEvent.click(browser.getByRole('button', { name: 'Открыть' }))
    await act(async () => { await until(f.source, { node: '/item' }, snapshot => snapshot.phase === 'ready') })
    assert.equal(JSON.parse(textarea(browser.getByLabelText('Данные узла')).value).value, 1)
    const save = browser.getByRole('button', { name: 'Сохранить' })
    assert.ok(save instanceof window.HTMLButtonElement)
    assert.equal(save.disabled, true)
  })

  it('presents accepted copies and settles the real Pending only after the updated snapshot', async t => {
    const f = await fixture('react-read'); t.after(f.close)
    const hook = renderHook(() => useNativeNode('/item'), { wrapper: f.wrapper })
    await act(async () => { await until(f.source, { node: '/item' }, snapshot => snapshot.phase === 'ready') })
    const original = hook.result.current.members[0]
    assert.ok('node' in original); assert.equal(typeof original.node.$rev, 'string'); assert.equal(original.node.value, 1)
    let accepted: Position | undefined
    await act(async () => {
      const pending = f.source.commit({ changes: [{ op: 'patch', path: '/item', ops: { $set: { value: 3 } } }] })
      accepted = (await pending.outcome).pos
      await until(f.source, { node: '/item' }, snapshot => snapshot.members[0]?.ver !== original.ver)
    })
    const updated = hook.result.current.members[0]
    assert.ok('node' in updated); assert.equal(updated.node.value, 3); assert.ok(accepted)
    assert.notEqual(updated.ver, original.ver)
    assert.equal(f.sent.some(request => request.t === 'read'), false)
    assert.equal(f.sent.filter(request => request.t === 'sub').length, 1)
  })

  it('switches paths without retaining the old copy and keeps unrelated writes from changing the current snapshot', async t => {
    const f = await fixture('react-switch'); t.after(f.close)
    const hook = renderHook(({ path }) => useNativeNode(path), { wrapper: f.wrapper, initialProps: { path: '/item' } })
    await act(async () => { await until(f.source, { node: '/item' }, snapshot => snapshot.phase === 'ready') })
    const previous = f.sent.find(request => request.t === 'sub'); assert.ok(previous?.t === 'sub')
    hook.rerender({ path: '/other' })
    assert.equal(hook.result.current.members.length, 0)
    await act(async () => { await until(f.source, { node: '/other' }, snapshot => snapshot.phase === 'ready') })
    const before = hook.result.current, current = before.members[0]; assert.ok('node' in current); assert.equal(current.node.value, 2)
    await act(async () => { await f.source.commit({ changes: [{ op: 'patch', path: '/item', ops: { $set: { value: 9 } } }] }).outcome })
    assert.equal(hook.result.current, before)
    assert.ok(f.sent.some(request => request.t === 'unsub' && request.sub === previous.sub))
    hook.unmount(); assert.equal(f.source.getSnapshot({ node: '/other' }).members.length, 0)
  })

  it('clears a mounted hook on source close and tolerates its later React cleanup', async t => {
    const f = await fixture('react-close'); t.after(f.close)
    const hook = renderHook(() => useNativeNode('/item'), { wrapper: f.wrapper })
    await act(async () => { await until(f.source, { node: '/item' }, snapshot => snapshot.phase === 'ready') })
    act(() => { f.source.close() })
    assert.equal(hook.result.current.phase, 'error'); assert.equal(hook.result.current.error?.code, 'CANCELLED')
    assert.deepEqual(hook.result.current.members, [])
    assert.doesNotThrow(() => hook.unmount())
  })

  it('binds identical paths under different providers to independent actual instances', async t => {
    const first = await fixture('react-first'), second = await fixture('react-second'); t.after(() => { first.close(); second.close() })
    const one = renderHook(() => useNativeNode('/item'), { wrapper: first.wrapper })
    const two = renderHook(() => useNativeNode('/item'), { wrapper: second.wrapper })
    await act(async () => { await Promise.all([until(first.source, { node: '/item' }, snapshot => snapshot.phase === 'ready'),
      until(second.source, { node: '/item' }, snapshot => snapshot.phase === 'ready')]) })
    const original = two.result.current, a = one.result.current.members[0], b = original.members[0]
    assert.ok('node' in a && 'node' in b); assert.notEqual(a.node.$id, b.node.$id)
    await act(async () => { await first.source.commit({ changes: [{ op: 'patch', path: '/item', ops: { $set: { value: 10 } } }] }).outcome })
    assert.equal(two.result.current, original)
    const changed = one.result.current.members[0]; assert.ok('node' in changed); assert.equal(changed.node.value, 10)
  })
})
