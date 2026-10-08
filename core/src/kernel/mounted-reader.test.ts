import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KernelError } from '#errors'
import { createInstanceFoundation } from '#kernel/instance'
import { createMemoryStore } from '#kernel/store/memory'
import { scanBudget } from '#kernel/store/contract'
import { A, R, W, type ChangeMember, type Position } from '#kernel/types'

/** Exercises mounted consumers through the genuine native auth, command and target factories. */
async function setup() {
  const root = createMemoryStore({ domain: 'mounted-consumers' })
  let saved: Position | undefined
  const instance = await createInstanceFoundation({ id: 'mounted-consumers', root, writerEpoch: 3,
    domains: [{ store: root, epoch: 'root-continuity', persistent: false }],
    counter: { async load() { return saved }, async save(pos) { saved = pos }, async freshEpoch(floor) { return floor + 1 } },
    initialCredential: { ttlMs: 60_000 }, firstAdmin: { path: '/admin', name: 'admin', password: 'mounted-password' } })
  assert.ok(instance.setupCredential)
  const admin = instance.commands(await instance.auth.openCredential(instance.setupCredential))
  const anonymous = instance.commands(await instance.auth.openCredential())
  let sequence = 0

  /** Uses the current durable intake for each real mutation. */
  function commit(changes: readonly ChangeMember[]) {
    return admin.commit({ changes,
      opId: { epoch: instance.writer.intake.epoch, time: Date.now(), nonce: `mounted-${sequence++}` } })
  }
  await commit([{ op: 'put', node: { $path: '/visible', $type: 't.dir',
    $acl: [{ subject: { group: 'public' }, grant: A | R | W }],
    '#a': { $type: 't.mount.memory', pattern: 'a' },
    '#b': { $type: 't.mount.memory', pattern: 'b' },
  } }])
  return { instance, admin, anonymous, commit }
}

describe('mounted native Reader and Commands', { timeout: 10_000 }, () => {
  it('merges children and reference includes from two actual memory target owners', async t => {
    const f = await setup()
    t.after(() => f.instance.close())
    await f.commit([{ op: 'put', node: { $path: '/visible/a', $type: 't.dir', value: 'a', link: '/visible/b' } }])
    await f.commit([{ op: 'put', node: { $path: '/visible/b', $type: 't.dir', value: 'b' } }])
    const result = await f.anonymous.read({ children: '/visible', include: [{ ref: 'link' }] })
    assert.equal(result.list.length, 2)
    assert.deepEqual(result.copies.map(copy => {
      assert.ok('node' in copy)
      return [copy.node.$path, copy.node.value]
    }).sort(), [['/visible/a', 'a'], ['/visible/b', 'b']])
  })

  it('refuses a mixed target ChangeSet before either existing value changes', async t => {
    const f = await setup()
    t.after(() => f.instance.close())
    for (const path of ['/visible/a', '/visible/b'])
      await f.commit([{ op: 'put', node: { $path: path, $type: 't.dir', value: 1 } }])
    await assert.rejects(f.commit(['/visible/a', '/visible/b'].map((path): ChangeMember => ({
      op: 'patch', path, ops: { $inc: { value: 1 } },
    }))), error => error instanceof KernelError && error.code === 'CROSS_DOMAIN')
    const result = await f.admin.read({ children: '/visible' })
    for (const copy of result.copies) {
      assert.ok('node' in copy)
      assert.equal(copy.node.value, 1)
    }
  })

  it('invalidates a children cursor when an intersecting mount changes with the same parent owner', async t => {
    const f = await setup()
    t.after(() => f.instance.close())
    for (const path of ['/visible/a', '/visible/b'])
      await f.commit([{ op: 'put', node: { $path: path, $type: 't.dir' } }])
    const parentOwner = f.instance.readerSource(scanBudget()).resolve('/visible').id
    const page = await f.anonymous.read({ children: '/visible', window: { limit: 1 } })
    assert.equal(page.list.length, 1)
    assert.ok(page.next)

    await f.commit([{ op: 'patch', path: '/visible', ops: {
      $set: { '#c': { $type: 't.mount.memory', pattern: 'c' } },
    } }])
    assert.equal(f.instance.readerSource(scanBudget()).resolve('/visible').id, parentOwner)
    await assert.rejects(f.anonymous.read({ children: '/visible', window: { limit: 1, after: page.next } }),
      error => error instanceof KernelError && error.code === 'INVALID')
  })

  it('merges mounted history and restores a deleted target node by its real journal address', async t => {
    const f = await setup()
    t.after(() => f.instance.close())
    await f.commit([{ op: 'put', node: { $path: '/visible/a', $type: 't.dir', value: 'a' } }])
    await f.commit([{ op: 'put', node: { $path: '/visible/b', $type: 't.dir', value: 'b' } }])
    const read = await f.admin.read({ node: '/visible/a' })
    const original = read.copies[0]
    assert.ok('node' in original)
    const deleted = await f.commit([{ op: 'remove', path: '/visible/a' }])
    assert.ok(deleted.pos)
    const history = await f.anonymous.read({ history: '/visible' })
    assert.ok(history.history?.some(entry => entry.path === '/visible/a' && entry.after === null))
    assert.ok(history.history?.some(entry => entry.path === '/visible/b'))
    await f.commit([{ op: 'restore', record: { pos: deleted.pos, id: original.node.$id } }])
    const restored = (await f.admin.read({ node: '/visible/a' })).copies[0]
    assert.ok('node' in restored)
    assert.equal(restored.node.$id, original.node.$id)
    assert.equal(restored.node.value, 'a')
  })
})
