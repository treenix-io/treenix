import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { it } from 'node:test'
import { createInstance } from '#kernel/instance'
import { createMemoryBlobStore } from '#kernel/blob-store-memory'
import { createMemoryStore } from '#kernel/store/memory'
import { drainSession } from '#kernel/session-delivery'
import { KernelError } from '#errors'
import { scanBudget } from '#kernel/store/contract'
import { LIMITS_PATH } from '#kernel/bootstrap'
import { A, R, type ChangeMember, type DeriveHandler, type ModuleManifest, type Position, type Preconditions } from '#kernel/types'

async function fixture(derive: DeriveHandler, executor: 'reader' | 'node' = 'reader', pattern = 'result',
  sources?: readonly string[], security: 'privileged-capability' | 'user-capability' = 'privileged-capability') {
  const id = randomUUID()
  const root = createMemoryStore({ domain: id })
  const borrowed = [createMemoryStore({ domain: randomUUID() }), createMemoryStore({ domain: randomUUID() })]
  let saved: Position | undefined
  const module: ModuleManifest = {
    id: 'views', types: [{ name: 'example.view', module: 'views', version: 0,
      security, schema: { type: 'object', properties: { pattern: { type: 'string' } } }, actions: {} },
      { name: 'example.record', module: 'views', version: 0, security: 'ordinary', schema: {}, actions: {} },
      { name: 'example.source', module: 'views', version: 0, security: 'privileged-capability', schema: {}, actions: {} }],
    security: [{ type: 'example.view', context: 'mount', async handler() {
      return executor === 'node' ? { kind: 'view', executor: 'node', derive, sources, async close() {} }
        : { kind: 'view', executor: 'reader', derive, async close() {} }
    } }, { type: 'example.source', context: 'mount', async handler(node) {
      const store = borrowed[node.generation === 2 ? 1 : 0]
      return { kind: 'store', store, resources: { epoch: randomUUID(), persistent: false,
        writerEpoch: 1, decisionHistory: 'fresh' }, async close() { store.close() } }
    } }], open: [],
  }
  const instance = await createInstance({ id, root: { kind: 'store', store: root }, modules: [module], blobs: createMemoryBlobStore(),
    provisioning: { writerEpoch: 1, domains: [{ store: root, epoch: randomUUID(), persistent: false }],
      credentialTtlMs: 60_000, counter: { async load() { return saved }, async save(pos) { saved = pos },
        async freshEpoch(floor) { return floor + 1 } },
      bootstrap: { kind: 'fresh', admin: { path: '/admin', name: 'admin', password: 'views-password' } } } })
  assert.ok(instance.setupCredential)
  const admin = await instance.openSession(instance.setupCredential)
  const draining = drainSession(admin)
  await admin.commit({ opId: { epoch: instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() },
    changes: [
      { op: 'put', node: { $path: '/source', $type: 't.dir' } },
      { op: 'put', node: { $path: '/source/a', $type: 't.dir', value: 1 } },
      { op: 'put', node: { $path: '/view', $type: 't.dir', '#mount': { $type: 'example.view', pattern } } },
    ] }).outcome
  const lane = await instance.openSession(instance.setupCredential)
  async function commit(changes: readonly ChangeMember[], expect?: Preconditions) {
    return admin.commit({ changes, expect, opId: { epoch: instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() } }).outcome
  }
  if (executor === 'node') {
    const declaration = await admin.read({ node: '/view' })
    const copy = declaration.copies[0]
    assert.ok(copy !== undefined && 'node' in copy)
    await commit([{ op: 'patch', path: '/source', ops: {
      $set: { $acl: [{ subject: { group: `n:${copy.node.$id}` }, grant: R }] },
    } }], { nodes: [{ path: copy.node.$path, rev: copy.node.$rev }] })
  }
  async function close() { await instance.close(); await draining }
  return { instance, root, admin, lane, commit, close, module, borrowed }
}

it('publishes a reader View through the native Session', { timeout: 10_000 }, async t => {
  let runs = 0
  const f = await fixture(async (_view, _request, read) => {
    runs++
    const result = await read.read({ children: '/source' })
    return { members: result.copies.map(copy => {
      assert.ok('node' in copy)
      return copy.node.$path
    }), rows: [{ key: 'count', value: result.list.length }] }
  }, 'reader', '')
  t.after(f.close)
  f.lane.sub({ children: '/view' })
  assert.equal((await f.lane.frames.next()).value?.t, 'welcome')
  const frame = (await f.lane.frames.next()).value
  assert.equal(frame?.t, 'snap')
  assert.ok(frame?.t === 'snap')
  assert.equal(frame.list.length, 1, JSON.stringify(frame))
  assert.deepEqual(frame.rows, [{ key: 'count', value: 1 }])
  assert.equal(runs, 1)
})

it('keeps an empty-pattern query mount equivalent to a plain live children selector without derive runs', { timeout: 10_000 }, async t => {
  let runs = 0
  const f = await fixture(async () => { runs++; return { members: [] } })
  t.after(f.close)
  await f.commit([{ op: 'patch', path: '/view', ops: { $set: {
    '#mount': { $type: 't.mount.query', pattern: '', source: '/source', match: { value: { $gte: 1 } } },
  } } }])
  const query = f.lane.sub({ children: '/view' })
  const plain = f.lane.sub({ children: '/source', where: { value: { $gte: 1 } } })
  assert.equal((await f.lane.frames.next()).value?.t, 'welcome')
  const snapshots = []
  for (let index = 0; index < 2; index++) {
    const frame = (await f.lane.frames.next()).value
    assert.ok(frame?.t === 'snap')
    snapshots.push(frame)
  }
  assert.deepEqual(snapshots[0].list, snapshots[1].list)
  await f.commit([{ op: 'put', node: { $path: '/source/b', $type: 't.dir', value: 2 } }])
  const update = (await f.lane.frames.next()).value
  assert.ok(update?.t === 'pos')
  const lists = update.changes.flatMap(change => change.op === 'list' ? [change] : [])
  assert.equal(lists.length, 2)
  assert.deepEqual(new Set(lists.map(change => change.sub)), new Set([query, plain]))
  assert.deepEqual(lists[0].diff, lists[1].diff)
  assert.equal(runs, 0)
  const read = await f.admin.read({ children: '/view' })
  assert.equal(read.list.length, 2)
  const anonymous = await f.instance.openSession()
  await f.commit([{ op: 'patch', path: '/source', ops: { $set: {
    $acl: [{ subject: { group: anonymous.actor.principal }, grant: R }],
  } } }])
  assert.equal((await anonymous.read({ children: '/source' })).list.length, 2)
  await assert.rejects(anonymous.read({ children: '/view' }),
    error => error instanceof KernelError && error.code === 'NOT_FOUND')
})

function latch() {
  let release: () => void = () => { throw new Error('Latch is not initialized') }
  const wait = new Promise<void>(resolve => { release = resolve })
  return { wait, release }
}

it('charges a real long migration diagnostic at its transported byte size', { timeout: 10_000 }, async t => {
  const f = await fixture(async (_node, _request, read) => {
    const source = await read.read({ children: '/source' })
    return { members: source.copies.map(copy => 'node' in copy ? copy.node.$path : copy.path) }
  }, 'node')
  t.after(f.close)
  await f.commit([
    { op: 'put', node: { $path: '/source/b', $type: 'example.record', value: 1 } },
    { op: 'patch', path: LIMITS_PATH, ops: { $set: { laneCoverageBytes: 900 } } },
  ])
  f.instance.registry.publish({ ...f.module,
    types: f.module.types.map(type => type.name === 'example.record' ? { ...type, version: 1 } : type),
    security: [...f.module.security, { type: 'example.record', context: 'migrate', handler: [{ from: 0, to: 1,
      up() { throw new KernelError('INVALID', 'Source migration cannot complete. '.repeat(100)) } }] }],
  })
  f.lane.sub({ children: '/view/result' })
  assert.equal((await f.lane.frames.next()).value?.t, 'welcome')
  const frame = (await f.lane.frames.next()).value
  assert.ok(frame?.t === 'end')
  assert.equal(frame.error.code, 'BUDGET')
})

it('delivers a changed migration message while the source error version stays unchanged', { timeout: 10_000 }, async t => {
  let diagnostic = 'First migration refusal'
  const f = await fixture(async (_node, _request, read) => {
    const source = await read.read({ children: '/source' })
    return { members: source.copies.map(copy => 'node' in copy ? copy.node.$path : copy.path) }
  }, 'node', 'result', ['/wake'])
  t.after(f.close)
  await f.commit([
    { op: 'put', node: { $path: '/source/b', $type: 'example.record', value: 1 } },
    { op: 'put', node: { $path: '/wake', $type: 't.dir', tick: 0 } },
  ])
  f.instance.registry.publish({ ...f.module,
    types: f.module.types.map(type => type.name === 'example.record' ? { ...type, version: 1 } : type),
    security: [...f.module.security, { type: 'example.record', context: 'migrate', handler: [{ from: 0, to: 1,
      up() { throw new KernelError('INVALID', diagnostic) } }] }],
  })
  f.lane.sub({ children: '/view/result' })
  assert.equal((await f.lane.frames.next()).value?.t, 'welcome')
  const first = (await f.lane.frames.next()).value
  assert.ok(first?.t === 'snap')
  const initial = first.viewErrors?.[0]
  assert.ok(initial)
  assert.equal(initial.error.message, diagnostic)
  diagnostic = 'Second migration refusal'
  await f.commit([{ op: 'patch', path: '/wake', ops: { $set: { tick: 1 } } }])
  const update = (await f.lane.frames.next()).value
  assert.ok(update?.t === 'result')
  const changed = update.viewErrors?.[0]
  assert.ok(changed)
  assert.equal(changed.ver, initial.ver)
  assert.equal(changed.error.code, initial.error.code)
  assert.equal(changed.error.message, diagnostic)
  assert.deepEqual(update.diff, [])
})

it('transfers a reader error to the retained ordinary copy when its valid run is older', { timeout: 10_000 }, async t => {
  const captured = latch()
  const resume = latch()
  let runs = 0
  const f = await fixture(async (_node, _request, read) => {
    const source = await read.read({ node: '/source/b' })
    const copy = source.copies[0]
    assert.ok(copy)
    if (++runs === 2) { captured.release(); await resume.wait }
    return { members: ['/source/b'], rows: [{ key: 'value', value: 'node' in copy ? copy.node.value : 'error' }] }
  })
  t.after(f.close)
  await f.commit([{ op: 'put', node: { $path: '/source/b', $type: 'example.record', value: 'invalid' } }])
  f.instance.registry.publish({ ...f.module, types: f.module.types.map(type => type.name === 'example.record'
    ? { ...type, schema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] } } : type) })
  f.lane.sub({ node: '/source/b' })
  assert.equal((await f.lane.frames.next()).value?.t, 'welcome')
  assert.equal((await f.lane.frames.next()).value?.t, 'snap')
  const view = f.lane.sub({ children: '/view/result' })
  const first = (await f.lane.frames.next()).value
  assert.ok(first?.t === 'snap' && first.sub === view)
  assert.equal(first.viewErrors?.length, 1)
  await f.commit([{ op: 'patch', path: '/source/b', ops: { $set: { value: 1 } } }])
  assert.equal((await f.lane.frames.next()).value?.t, 'pos')
  await captured.wait
  await f.commit([{ op: 'patch', path: '/source/b', ops: { $set: { value: 2 } } }])
  assert.equal((await f.lane.frames.next()).value?.t, 'pos')
  resume.release()
  const old = (await f.lane.frames.next()).value
  assert.ok(old?.t === 'result')
  assert.deepEqual(old.rows, [{ key: 'value', value: 1 }])
  assert.deepEqual(old.viewErrors, [])
  assert.equal(old.copies.length, 1)
  const canonical = old.copies[0]
  assert.ok(canonical && 'node' in canonical)
  assert.equal(canonical.node.value, 2)
  assert.deepEqual(old.diff, [])
  const current = (await f.lane.frames.next()).value
  assert.ok(current?.t === 'result')
  assert.deepEqual(current.rows, [{ key: 'value', value: 2 }])
})

for (const sourceAccess of ['denied', 'admin'] as const)
it(`delivers a node View schema error with source access ${sourceAccess}`, { timeout: 2_000 }, async t => {
  const f = await fixture(async (_node, _request, read) => {
    const source = await read.read({ children: '/source' })
    return { members: source.copies.map(copy => 'node' in copy ? copy.node.$path : copy.path) }
  }, 'node')
  t.after(f.close)
  const declaration = (await f.admin.read({ node: '/view' })).copies[0]
  assert.ok(declaration && 'node' in declaration)
  const recipient = sourceAccess === 'denied' ? await f.instance.openSession() : f.lane
  await f.commit([
    { op: 'put', node: { $path: '/source/b', $type: 'example.record', value: 'invalid',
      $acl: [{ subject: { group: `n:${declaration.node.$id}` }, grant: R | A }], $owner: f.admin.actor.principal } },
    { op: 'patch', path: '/view', ops: { $set: { $acl: [{ subject: { group: recipient.actor.principal }, grant: R }] } } },
  ], { nodes: [{ path: declaration.node.$path, rev: declaration.node.$rev }] })
  f.instance.registry.publish({ ...f.module, types: f.module.types.map(type => type.name === 'example.record'
    ? { ...type, schema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] } } : type) })
  if (sourceAccess === 'denied')
    await assert.rejects(recipient.read({ node: '/source/b' }),
      error => error instanceof KernelError && error.code === 'NOT_FOUND')
  recipient.sub({ children: '/view/result', sort: [['$acl', 1], ['$owner', 1], ['value', 1]] })
  assert.equal((await recipient.frames.next()).value?.t, 'welcome')
  const frame = (await recipient.frames.next()).value
  assert.ok(frame?.t === 'snap')
  assert.equal(frame.list.length, 2)
  const invalid = frame.viewErrors?.[0]
  assert.ok(invalid && 'error' in invalid)
  assert.deepEqual(invalid.sort, { $acl: undefined, $owner: undefined, value: 'invalid' })
})

for (const executor of ['reader', 'node'] as const)
it(`passes through a schema ErrorCopy beside valid ${executor} View members`, { timeout: 10_000 }, async t => {
  const f = await fixture(async (_node, _request, read) => {
    const source = await read.read({ children: '/source' })
    return { members: source.copies.map(copy => 'node' in copy ? copy.node.$path : copy.path) }
  }, executor)
  t.after(f.close)
  if (executor === 'node') {
    const declaration = (await f.admin.read({ node: '/view' })).copies[0]
    assert.ok(declaration && 'node' in declaration)
    await f.commit([{ op: 'patch', path: '/source', ops: { $set: {
      $acl: [{ subject: { group: `n:${declaration.node.$id}` }, grant: R | A }],
      $owner: f.admin.actor.principal,
    } } }], { nodes: [{ path: declaration.node.$path, rev: declaration.node.$rev }] })
  }
  await f.commit([{ op: 'put', node: { $path: '/source/b', $type: 'example.record', value: 'invalid' } }])
  f.instance.registry.publish({ ...f.module, types: f.module.types.map(type => type.name === 'example.record'
    ? { ...type, schema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] } }
    : type) })
  const ordinary = await f.admin.read({ children: '/source' })
  assert.equal(ordinary.copies.length, 2)
  assert.ok(ordinary.copies.some(copy => 'error' in copy))
  f.lane.sub({ children: '/view/result', sort: executor === 'node' ? [['$acl', 1], ['$owner', 1], ['value', 1]] : [['value', 1]],
    where: executor === 'node' ? { $owner: { $exists: false } } : undefined,
    include: executor === 'node' ? [{ ref: '$owner' }] : undefined })
  assert.equal((await f.lane.frames.next()).value?.t, 'welcome')
  const frame = (await f.lane.frames.next()).value
  assert.ok(frame?.t === 'snap')
  assert.equal(frame.list.length, 2)
  assert.equal(frame.copies.length, executor === 'node' ? 0 : 1)
  assert.equal(frame.viewErrors?.length, 1)
  if (executor === 'node') {
    assert.equal(frame.computed?.length, 1)
    assert.equal('$acl' in frame.computed[0], false)
    assert.equal('$owner' in frame.computed[0], false)
  }
  assert.ok(frame.viewErrors?.length === 1)
  const invalid = frame.viewErrors?.[0]
  assert.ok(invalid && 'error' in invalid)
  assert.deepEqual(invalid.sort, executor === 'node' ? { $acl: undefined, $owner: undefined, value: 'invalid' } : { value: 'invalid' })
})

it('reads a View once through the actual Session read contract', { timeout: 10_000 }, async t => {
  let runs = 0
  const f = await fixture(async (_node, _request, read) => {
    runs++
    const source = await read.read({ node: '/source/a' })
    return { members: ['/source/a'], rows: [{ key: 'count', count: source.list.length }] }
  })
  t.after(f.close)
  const result = await f.admin.read({ children: '/view/result' })
  assert.equal(result.list.length, 1)
  assert.equal(result.copies.length, 1)
  assert.deepEqual(result.rows, [{ key: 'count', count: 1 }])
  assert.equal(runs, 1)
  const anonymous = await f.instance.openSession()
  await assert.rejects(anonymous.read({ children: '/view/result' }),
    error => error instanceof KernelError && error.code === 'NOT_FOUND')
  assert.equal(runs, 1)
})

it('refuses a suspended direct read after its View target is replaced', { timeout: 10_000 }, async t => {
  const captured = latch()
  const resume = latch()
  let runs = 0
  const f = await fixture(async (_node, _request, read) => {
    runs++
    await read.read({ node: '/source/a' })
    captured.release()
    await resume.wait
    return { members: ['/source/a'], rows: [{ key: 'old', value: 1 }] }
  })
  t.after(f.close)
  const pending = f.admin.read({ children: '/view/result' })
  const denied = assert.rejects(pending, error => error instanceof KernelError && error.code === 'CONFLICT')
  await captured.wait
  await f.commit([{ op: 'patch', path: '/view', ops: { $set: {
    '#mount': { $type: 'example.view', pattern: 'replacement' },
  } } }])
  resume.release()
  await denied
  assert.equal(runs, 1)
})

it('drops an external rows run when its declared source changes mount generation', { timeout: 10_000 }, async t => {
  const captured = latch()
  const resume = latch()
  let runs = 0
  const f = await fixture(async () => {
    const source = (await f.root.scan({ range: { children: '/source' }, budget: scanBudget() })).items[0]
    assert.ok(source)
    if (++runs === 1) { captured.release(); await resume.wait }
    return { members: [], rows: [{ key: 'value', value: source.value }] }
  }, 'node', 'result', ['/source'])
  t.after(f.close)
  await f.commit([{ op: 'put', node: { $path: '/other', $type: 't.dir' } }])
  const ordinary = f.lane.sub({ children: '/other' })
  assert.equal((await f.lane.frames.next()).value?.t, 'welcome')
  const plain = (await f.lane.frames.next()).value
  assert.ok(plain?.t === 'snap' && plain.sub === ordinary)
  const view = f.lane.sub({ children: '/view/result' })
  await captured.wait
  await f.commit([
    { op: 'patch', path: '/source/a', ops: { $set: { value: 2 } } },
    { op: 'patch', path: '/source', ops: { $set: {
      '#mount': { $type: 't.mount.query', pattern: '', source: '/other', match: {} },
    } } },
  ])
  resume.release()
  let reset = false
  for (;;) {
    const frame = (await f.lane.frames.next()).value
    assert.ok(frame)
    if (frame.t === 'reset') { assert.equal(frame.sub, view); reset = true }
    if (frame.t === 'snap' && frame.sub === view) {
      assert.deepEqual(frame.rows, [{ key: 'value', value: 2 }])
      break
    }
    assert.ok(frame.t !== 'end')
  }
  assert.equal(reset, true)
  assert.equal(runs, 2)
  await f.commit([{ op: 'put', node: { $path: '/other/a', $type: 't.dir' } }])
  for (;;) {
    const frame = (await f.lane.frames.next()).value
    assert.ok(frame && frame.t !== 'end')
    if (frame.t === 'pos' && frame.changes.some(change => change.op === 'list' && change.sub === ordinary)) break
  }
})

it('drops an external rows run when its source Store changes continuity', { timeout: 10_000 }, async t => {
  const captured = latch()
  const resume = latch()
  let phase = 0
  let runs = 0
  const f = await fixture(async () => {
    const source = await f.borrowed[phase].scan({ range: { children: '/remote' }, budget: scanBudget() })
    if (++runs === 1) { captured.release(); await resume.wait }
    return { members: [], rows: source.items.map(node => ({ key: 'value', value: node.value })) }
  }, 'node', 'result', ['/remote'])
  t.after(f.close)
  await f.commit([{ op: 'put', node: { $path: '/remote', $type: 'example.source', pattern: '', generation: 1 } }])
  await f.commit([{ op: 'put', node: { $path: '/remote/a', $type: 't.dir', value: 1 } }])
  const before = f.instance.writer.intake.epoch
  const ordinary = f.lane.sub({ children: '/source' })
  assert.equal((await f.lane.frames.next()).value?.t, 'welcome')
  assert.equal((await f.lane.frames.next()).value?.t, 'snap')
  const view = f.lane.sub({ children: '/view/result' })
  await captured.wait
  await f.commit([{ op: 'patch', path: '/remote', ops: { $set: { generation: 2 } } }])
  phase = 1
  await f.commit([{ op: 'put', node: { $path: '/remote/a', $type: 't.dir', value: 2 } }])
  assert.notEqual(f.instance.writer.intake.epoch, before)
  resume.release()
  for (;;) {
    const frame = (await f.lane.frames.next()).value
    assert.ok(frame && frame.t !== 'end')
    if (frame.t === 'reset') assert.equal(frame.sub, view)
    if (frame.t === 'snap' && frame.sub === view) {
      assert.deepEqual(frame.rows, [{ key: 'value', value: 2 }])
      break
    }
  }
  await f.commit([{ op: 'put', node: { $path: '/source/b', $type: 't.dir' } }])
  for (;;) {
    const frame = (await f.lane.frames.next()).value
    assert.ok(frame && frame.t !== 'end')
    if (frame.t === 'pos' && frame.changes.some(change => change.op === 'list' && change.sub === ordinary)) break
  }
})

it('publishes a run dirtied by a write to its first source, then reads the new state', { timeout: 10_000 }, async t => {
  const readDone = latch()
  const continueRun = latch()
  let runs = 0
  const started: number[] = []
  const f = await fixture(async (_node, _request, read) => {
    started.push(performance.now())
    const result = await read.read({ node: '/source/a' })
    const copy = result.copies[0]
    assert.ok(copy !== undefined && 'node' in copy)
    if (++runs === 1) { readDone.release(); await continueRun.wait }
    return { members: [copy.node.$path], rows: [{ key: 'value', value: copy.node.value }] }
  })
  t.after(f.close)
  f.lane.sub({ children: '/view/result' })
  assert.equal((await f.lane.frames.next()).value?.t, 'welcome')
  await readDone.wait
  await f.commit([{ op: 'patch', path: '/source/a', ops: { $set: { value: 2 } } }])
  continueRun.release()
  const first = (await f.lane.frames.next()).value
  assert.ok(first?.t === 'snap')
  assert.deepEqual(first.rows, [{ key: 'value', value: 1 }])
  let second = (await f.lane.frames.next()).value
  if (second?.t === 'pos') second = (await f.lane.frames.next()).value
  assert.ok(second?.t === 'result')
  assert.deepEqual(second.rows, [{ key: 'value', value: 2 }])
  assert.equal(runs, 2)
  assert.ok(started[1] - started[0] >= f.instance.limits().recomputeIntervalMs)
})

it('publishes a run started before revoke, then reads with the revoked source rights', { timeout: 10_000 }, async t => {
  const captured = latch()
  const resume = latch()
  let runs = 0
  const f = await fixture(async (_node, _request, read) => {
    const result = await read.read({ children: '/source' })
    if (++runs === 1) { captured.release(); await resume.wait }
    return { members: result.copies.map(copy => {
      assert.ok('node' in copy)
      return copy.node.$path
    }), rows: [{ key: 'count', count: result.list.length }] }
  })
  t.after(f.close)
  const lane = await f.instance.openSession()
  const principal = lane.actor.principal
  await f.commit([
    { op: 'patch', path: '/source', ops: { $set: { $acl: [{ subject: { group: principal }, grant: R }] } } },
    { op: 'patch', path: '/view', ops: { $set: { $acl: [{ subject: { group: principal }, grant: R }] } } },
  ])
  lane.sub({ children: '/view/result' })
  assert.equal((await lane.frames.next()).value?.t, 'welcome')
  await captured.wait
  await f.commit([{ op: 'patch', path: '/source', ops: { $set: { $acl: [] } } }])
  await f.commit([{ op: 'patch', path: '/source/a', ops: { $set: { value: 2 } } }])
  resume.release()
  const old = (await lane.frames.next()).value
  assert.ok(old?.t === 'snap')
  assert.equal(old.list.length, 1)
  const oldCopy = old.copies[0]
  assert.ok(oldCopy !== undefined && 'node' in oldCopy)
  assert.equal(oldCopy.node.value, 1)
  const fresh = (await lane.frames.next()).value
  assert.ok(fresh?.t === 'result')
  assert.deepEqual(fresh.rows, [{ key: 'count', count: 0 }])
  assert.deepEqual(fresh.copies, [])
  assert.equal(fresh.diff.length, 1)
  assert.equal(runs, 2)
})

it('follows View includes and retains a source copy covered by another subscription', { timeout: 10_000 }, async t => {
  const f = await fixture(async (_node, _request, read) => {
    const source = await read.read({ children: '/source' })
    return { members: source.copies.map(copy => {
      assert.ok('node' in copy)
      return copy.node.$path
    }) }
  })
  t.after(f.close)
  await f.commit([
    { op: 'put', node: { $path: '/related', $type: 't.dir' } },
    { op: 'put', node: { $path: '/related/b', $type: 't.dir', value: 10 } },
    { op: 'put', node: { $path: '/related/c', $type: 't.dir', value: 20 } },
    { op: 'patch', path: '/source/a', ops: { $set: { link: '/related/b' } } },
  ])
  f.lane.sub({ children: '/view/result', include: [{ ref: 'link' }] })
  f.lane.sub({ node: '/related/b' })
  assert.equal((await f.lane.frames.next()).value?.t, 'welcome')
  let view = (await f.lane.frames.next()).value
  let ordinary = (await f.lane.frames.next()).value
  assert.ok(view?.t === 'snap' && ordinary?.t === 'snap')
  if (view.list.length !== 1 || view.covered?.length !== 2) [view, ordinary] = [ordinary, view]
  assert.equal(view.covered?.length, 2)
  assert.equal(new Set([...view.copies, ...ordinary.copies].map(copy => 'node' in copy ? copy.node.$id : copy.id)).size, 2)
  await f.commit([{ op: 'patch', path: '/source/a', ops: { $set: { link: '/related/c' } } }])
  const changed = (await f.lane.frames.next()).value
  assert.ok(changed?.t === 'result')
  assert.equal(changed.covered?.length, 2)
  assert.equal(changed.copies.some(copy => 'node' in copy && copy.node.$path === '/related/c'), true)
  assert.equal(changed.covered?.includes(ordinary.list[0]), false)
})

it('keeps a read budget refusal fatal across all reads in one View run', { timeout: 10_000 }, async t => {
  let reads = 0
  const f = await fixture(async (_node, _request, read) => {
    for (let index = 0; index < 100; index++) {
      try { reads++; await read.read({ node: '/source/a' }) }
      catch (error) {
        assert.ok(error instanceof KernelError && error.code === 'BUDGET')
        break
      }
    }
    return { members: [] }
  })
  t.after(f.close)
  await f.commit([{ op: 'patch', path: LIMITS_PATH, ops: { $set: { readNodes: 20 } } }])
  f.lane.sub({ children: '/view/result' })
  assert.equal((await f.lane.frames.next()).value?.t, 'welcome')
  const end = (await f.lane.frames.next()).value
  assert.ok(end?.t === 'end', JSON.stringify({ end, reads }))
  assert.equal(end.error.code, 'BUDGET')
  assert.ok(reads > 1 && reads < 100)
})

it('ends a growing rows result while keeping unrelated ordinary coverage alive', { timeout: 10_000 }, async t => {
  const f = await fixture(async (_node, _request, read) => {
    const source = await read.read({ node: '/source/a' })
    const copy = source.copies[0]
    assert.ok(copy !== undefined && 'node' in copy)
    return { members: [], rows: [{ key: 'value', text: copy.node.value === 1 ? 'small' : 'x'.repeat(2000) }] }
  })
  t.after(f.close)
  await f.commit([{ op: 'patch', path: LIMITS_PATH, ops: { $set: { laneCoverageBytes: 900 } } }])
  const ordinary = f.lane.sub({ node: '/source/a' })
  const derived = f.lane.sub({ children: '/view/result' })
  assert.equal((await f.lane.frames.next()).value?.t, 'welcome')
  for (let index = 0; index < 2; index++) assert.equal((await f.lane.frames.next()).value?.t, 'snap')
  await f.commit([{ op: 'patch', path: '/source/a', ops: { $set: { value: 2 } } }])
  const position = (await f.lane.frames.next()).value
  assert.ok(position?.t === 'pos')
  const end = (await f.lane.frames.next()).value
  assert.ok(end?.t === 'end')
  assert.equal(end.sub, derived)
  assert.equal(end.error.code, 'BUDGET')
  await f.commit([{ op: 'patch', path: '/source/a', ops: { $set: { value: 3 } } }])
  const alive = (await f.lane.frames.next()).value
  assert.ok(alive?.t === 'pos')
  assert.equal(alive.changes.some(change => change.op === 'list' && change.sub === ordinary && change.diff.some(item => 'remove' in item)), false)
  assert.equal(alive.changes.some(change => change.op === 'patch' || change.op === 'put'), true)
})

it('rejects writes to a View and reads of another View through its Reader', { timeout: 10_000 }, async t => {
  const f = await fixture(async (_node, _request, read) => {
    await read.read({ children: '/view/result' })
    return { members: [] }
  })
  t.after(f.close)
  f.lane.sub({ children: '/view/result' })
  assert.equal((await f.lane.frames.next()).value?.t, 'welcome')
  const end = (await f.lane.frames.next()).value
  assert.ok(end?.t === 'end')
  assert.equal(end.error.code, 'INVALID')
  await assert.rejects(f.commit([{ op: 'put', node: { $path: '/view/result/new', $type: 't.dir' } }]),
    error => error instanceof KernelError && error.code === 'READ_ONLY')
})

it('wakes a privileged node View from actual writes in its declared source range', { timeout: 10_000 }, async t => {
  let runs = 0
  const f = await fixture(async () => {
    runs++
    const source = await f.root.scan({ range: { children: '/source' }, budget: scanBudget() })
    return { members: [], rows: source.items.map(node => ({ key: node.$id, value: node.value })) }
  }, 'node', 'result', ['/source'])
  t.after(f.close)
  f.lane.sub({ children: '/view/result' })
  assert.equal((await f.lane.frames.next()).value?.t, 'welcome')
  const first = (await f.lane.frames.next()).value
  assert.ok(first?.t === 'snap')
  assert.equal(first.rows?.[0].value, 1)
  await f.commit([{ op: 'patch', path: '/source/a', ops: { $set: { value: 2 } } }])
  const second = (await f.lane.frames.next()).value
  assert.ok(second?.t === 'result')
  assert.equal(second.rows?.[0].value, 2)
  await f.commit([{ op: 'remove', path: '/source/a' }])
  const empty = (await f.lane.frames.next()).value
  assert.ok(empty?.t === 'result')
  assert.deepEqual(empty.rows, [])
  assert.equal(runs, 3)
})

it('rejects declared sources returned by a user capability', { timeout: 10_000 }, async t => {
  const f = await fixture(async () => ({ members: [] }), 'node', 'result', ['/source'], 'user-capability')
  t.after(f.close)
  f.lane.sub({ children: '/view/result' })
  assert.equal((await f.lane.frames.next()).value?.t, 'welcome')
  const end = (await f.lane.frames.next()).value
  assert.ok(end?.t === 'end')
  assert.equal(end.error.code, 'FORBIDDEN')
})

it('shares one node-executor run across three independently filtered subscriptions', { timeout: 10_000 }, async t => {
  let runs = 0
  const f = await fixture(async (_node, request, read) => {
    runs++
    assert.deepEqual(request, {})
    const result = await read.read({ children: '/source' })
    return { members: result.copies.map(copy => {
      assert.ok('node' in copy)
      return copy.node.$path
    }), rows: [{ key: 'count', count: result.list.length }] }
  }, 'node')
  t.after(f.close)
  await f.commit([{ op: 'put', node: { $path: '/source/b', $type: 't.dir', value: 2 } }])
  f.lane.sub({ children: '/view/result' })
  f.lane.sub({ children: '/view/result', where: { value: 1 } })
  f.lane.sub({ children: '/view/result', where: { value: 2 } })
  assert.equal((await f.lane.frames.next()).value?.t, 'welcome')
  const sizes: number[] = []
  for (let index = 0; index < 3; index++) {
    const frame = (await f.lane.frames.next()).value
    assert.ok(frame?.t === 'snap')
    sizes.push(frame.list.length)
    assert.equal(frame.copies.length, 0)
    assert.equal(frame.computed?.length, frame.list.length)
    for (const node of frame.computed ?? []) {
      assert.equal('$acl' in node, false)
      assert.equal('$owner' in node, false)
    }
  }
  assert.deepEqual(sizes, [2, 1, 1])
  assert.equal(runs, 1)
})

it('evicts computed window members and resumes using the View cursor', { timeout: 10_000 }, async t => {
  let runs = 0
  const f = await fixture(async (_node, request, read) => {
    runs++
    assert.deepEqual(request, {})
    const source = await read.read({ children: '/source' })
    return { members: source.copies.map(copy => {
      assert.ok('node' in copy)
      return copy.node.$path
    }), rows: [{ key: 'total', count: source.list.length }] }
  }, 'node')
  t.after(f.close)
  await f.commit([
    { op: 'patch', path: '/source/a', ops: { $set: { payload: 'a'.repeat(400) } } },
    { op: 'put', node: { $path: '/source/b', $type: 't.dir', value: 2, payload: 'b'.repeat(400) } },
    { op: 'put', node: { $path: '/source/c', $type: 't.dir', value: 3, payload: 'c'.repeat(400) } },
    { op: 'patch', path: LIMITS_PATH, ops: { $set: { laneCoverageBytes: 900 } } },
  ])
  f.lane.sub({ children: '/view/result', sort: [['value', 1]], window: { limit: 3, evict: true } })
  assert.equal((await f.lane.frames.next()).value?.t, 'welcome')
  const first = (await f.lane.frames.next()).value
  assert.ok(first?.t === 'snap')
  assert.equal(first.list.length, 1)
  assert.equal(first.computed?.[0].value, 1)
  assert.deepEqual(first.rows, [{ key: 'total', count: 3 }])
  assert.ok(first.next)
  const page = await f.instance.openSession(f.instance.setupCredential)
  page.sub({ children: '/view/result', sort: [['value', 1]], window: { limit: 3, evict: true, after: first.next } })
  assert.equal((await page.frames.next()).value?.t, 'welcome')
  const second = (await page.frames.next()).value
  assert.ok(second?.t === 'snap')
  assert.equal(second.list.length, 1)
  assert.equal(second.computed?.[0].value, 2)
  assert.deepEqual(second.rows, [{ key: 'total', count: 3 }])
  assert.equal(runs, 1)
  await f.commit([{ op: 'remove', path: '/source/c' }])
  for (const lane of [f.lane, page]) {
    const frame = (await lane.frames.next()).value
    assert.ok(frame?.t === 'result')
    assert.deepEqual(frame.rows, [{ key: 'total', count: 2 }])
  }
  assert.equal(runs, 2)
})

it('keeps the shared base copy current when a suspended reader View publishes its older run', { timeout: 10_000 }, async t => {
  const captured = latch()
  const resume = latch()
  let runs = 0
  const f = await fixture(async (_node, _request, read) => {
    const source = await read.read({ node: '/source/a' })
    const copy = source.copies[0]
    assert.ok(copy !== undefined && 'node' in copy)
    if (++runs === 1) { captured.release(); await resume.wait }
    return { members: [copy.node.$path], rows: [{ key: 'value', value: copy.node.value }] }
  })
  t.after(f.close)
  f.lane.sub({ node: '/source/a' })
  assert.equal((await f.lane.frames.next()).value?.t, 'welcome')
  const base = (await f.lane.frames.next()).value
  assert.ok(base?.t === 'snap')
  assert.equal(base.copies.length, 1)
  f.lane.sub({ children: '/view/result' })
  await captured.wait
  await f.commit([{ op: 'patch', path: '/source/a', ops: { $set: { value: 2 } } }])
  const position = (await f.lane.frames.next()).value
  assert.ok(position?.t === 'pos')
  assert.ok(position.changes.some(change => change.op === 'patch' || change.op === 'put'))
  resume.release()
  const old = (await f.lane.frames.next()).value
  assert.ok(old?.t === 'snap')
  assert.deepEqual(old.rows, [{ key: 'value', value: 1 }])
  assert.deepEqual(old.copies, [])
  const fresh = (await f.lane.frames.next()).value
  assert.ok(fresh?.t === 'result')
  assert.deepEqual(fresh.rows, [{ key: 'value', value: 2 }])
  assert.deepEqual(fresh.copies, [])
})
