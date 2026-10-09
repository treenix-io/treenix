import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KernelError } from '#errors'
import type { Frame, ReadResult } from '#kernel/types'
import { decodeFrame, decodeRequests, encodeFrame, isReadResult } from '#protocol/twp'

const code = (value: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === value
const decode = (value: unknown) => decodeRequests(JSON.stringify(value), 512 * 1024)

describe('native TWP boundary', () => {
  it('checks bytes before parsing and refuses malformed UTF-8 and prototype keys', () => {
    assert.throws(() => decodeRequests('!'.repeat(513 * 1024), 512 * 1024), code('BUDGET'))
    const request = JSON.stringify({ t: 'act', req: 'a', path: '/a', action: 'check', args: 'é' })
    assert.throws(() => decodeRequests(request, request.length), code('BUDGET'))
    assert.throws(() => decodeRequests(Uint8Array.from([0xc0, 0xaf]), 512), code('INVALID'))
    assert.throws(() => decodeRequests('{"t":"hi","constructor":{}}', 512), code('INVALID'))
    assert.deepEqual(decodeRequests(' {"t":"hi"} '.padEnd(512 * 1024), 512 * 1024), [{ t: 'hi' }])
  })
  it('validates all members and canonical paths without dropping invalid input', () => {
    assert.throws(() => decode([{ t: 'unsub', sub: 'ok' }, { t: 'commit', req: 'bad', changes: [], opId: null }]), code('INVALID'))
    for (const selector of [{ node: '/a/../b' }, { children: '/a?b' }, { node: '/a', include: [{ path: '/a%2fb' }] }, { node: '/a', children: '/b' }])
      assert.throws(() => decode({ t: 'read', req: 'r', selector }), code('INVALID'))
    assert.throws(() => decode({ t: 'sub', sub: 'h', selector: { history: '/' } }), code('INVALID'))
    assert.deepEqual(decode({ t: 'read', req: 'r', selector: { children: '/', sort: [['$order', 1]], window: { limit: 2 } } })[0],
      { t: 'read', req: 'r', selector: { children: '/', sort: [['$order', 1]], window: { limit: 2 } } })
  })
  it('keeps mutation and actor identity inputs exact', () => {
    const input = { t: 'commit', req: 'c', changes: [{ op: 'patch', path: '/a', ops: { $set: { name: 'after' } } }],
      expect: { nodes: [{ path: '/a', rev: 'before' }] }, opId: { epoch: 'intake', time: 12, nonce: 'once' } }
    assert.deepEqual(decode(input), [input])
    assert.throws(() => decode({ ...input, actor: { principal: 'u:forged' } }), code('INVALID'))
    assert.throws(() => decode({ t: 'act', req: 'a', path: '/a', action: 'save', component: 'named', args: {} }), code('INVALID'))
    assert.deepEqual(decode({ t: 'act', req: 'a', path: '/a', action: 'save', component: '#named', args: null })[0],
      { t: 'act', req: 'a', path: '/a', action: 'save', component: '#named', args: null })
  })
  it('limits coverage controls to removals and membership changes', () => {
    const pos = { instance: 'test', epoch: 1, seq: 4 }
    const control = { t: 'pos', pos, coverage: true, changes: [{ op: 'del', id: 'gone' }] }
    assert.deepEqual(decodeFrame(JSON.stringify(control), 512), control)
    const patch = { op: 'patch', id: 'x', base: 'v1', delta: { set: { name: 'x' } }, ver: 'v2', bits: 1 }
    assert.throws(() => decodeFrame(JSON.stringify({ ...control, changes: [patch] }), 512), code('INVALID'))
    assert.throws(() => decodeFrame(JSON.stringify({ ...control, coverage: false }), 512), code('INVALID'))
    assert.equal(decodeFrame(JSON.stringify({ t: 'pos', pos, changes: [patch] }), 512).t, 'pos')
  })

  it('carries renewed intake only on ordinary position frames', () => {
    const pos = { instance: 'test', epoch: 1, seq: 4 }
    const progress: Frame = { t: 'pos', pos, changes: [], intake: 'renewed-intake' }
    assert.deepEqual(decodeFrame(encodeFrame(progress), 512), progress)
    assert.throws(
      () => decodeFrame(JSON.stringify({ ...progress, coverage: true }), 512),
      code('INVALID'),
    )
    for (const intake of ['', 42, null, false, {}])
      assert.throws(
        () => decodeFrame(JSON.stringify({ ...progress, intake }), 512),
        code('INVALID'),
      )
  })

  it('serializes native errors in failures, subscriptions and nested read copies', () => {
    const failure = new KernelError('NOT_FOUND', 'Node is absent')
    const frames: Frame[] = [{ t: 'fail', req: 'missing', error: failure }, { t: 'end', sub: 'hidden', error: failure }]
    for (const frame of frames) {
      const decoded = decodeFrame(encodeFrame(frame), 4096); assert.ok(decoded.t === 'fail' || decoded.t === 'end')
      assert.equal(decoded.error.code, failure.code); assert.equal(decoded.error.message, failure.message)
    }
    const result: ReadResult = { list: ['broken'], copies: [{ id: 'broken', path: '/broken', error: failure, ver: 'v1' }], at: [{ instance: 'test', epoch: 1, seq: 1 }] }
    const snap = decodeFrame(encodeFrame({ t: 'snap', sub: 's', gen: 1, ...result }), 4096); assert.ok(snap.t === 'snap')
    assert.ok('error' in snap.copies[0]); assert.equal(snap.copies[0].error.code, failure.code)
    const done = decodeFrame(encodeFrame({ t: 'done', req: 'r', value: result }), 4096); assert.ok(done.t === 'done' && isReadResult(done.value))
    assert.ok('error' in done.value.copies[0]); assert.equal(done.value.copies[0].error.message, failure.message)
  })

  it('carries page cursors and include ownership through snapshots and position changes', () => {
    const pos = { instance: 'test', epoch: 1, seq: 4 }
    const snap: Frame = { t: 'snap', sub: 'page', gen: 1, list: ['member'], covered: ['member', 'included'], copies: [], at: [pos], next: 'cursor' }
    assert.deepEqual(decodeFrame(encodeFrame(snap), 4096), snap)
    const changed: Frame = { t: 'pos', pos, changes: [{ op: 'list', sub: 'page', gen: 1, diff: [{ remove: 'member' }], covered: ['included'], next: 'next-cursor' }] }
    assert.deepEqual(decodeFrame(encodeFrame(changed), 4096), changed)
    assert.throws(() => decodeFrame(JSON.stringify({ ...snap, covered: [42] }), 4096), code('INVALID'))
  })
})
