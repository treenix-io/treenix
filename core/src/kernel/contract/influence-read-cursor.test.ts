import assert from 'node:assert/strict'
import { it } from 'node:test'
import { KernelError } from '#errors'
import { createInfluenceIndex, type InfluenceContext } from '#kernel/influence'
import { visibleNode } from '#kernel/projection'
import type { Position, StoredNode } from '#kernel/types'

const initial: Position = { instance: 'read-cursor', epoch: 1, seq: 1 }
const current: Position = { ...initial, seq: 2 }
const context: InfluenceContext = {
  project: (node) => visibleNode(node, 0),
  work: { used: 0, limit: 100 },
}
const conflict = (error: unknown) => error instanceof KernelError && error.code === 'CONFLICT'

it('accepts an unchanged equal read cursor while reserved writes require a later position', () => {
  const index = createInfluenceIndex({ position: initial, domains: ['root'] })
  assert.doesNotThrow(() =>
    index.check({ children: '/data' }, [initial], initial, ['root'], context, true),
  )
  assert.throws(
    () => index.check({ children: '/data' }, [initial], initial, ['root'], context),
    conflict,
  )
  assert.throws(
    () => index.check({ children: '/data' }, [current], initial, ['root'], context, true),
    conflict,
  )
})

it('includes an accepted change at the current read cursor and preserves exclusive write checks', () => {
  const index = createInfluenceIndex({ position: initial, domains: ['root'] })
  const node: StoredNode = { $id: 'child', $path: '/data/child', $type: 't.dir', $pos: current }
  index.record('root', current, [{ id: node.$id, before: null, after: node }])
  assert.throws(
    () => index.check({ children: '/data' }, [initial], current, ['root'], context, true),
    conflict,
  )
  assert.doesNotThrow(() =>
    index.check({ children: '/data' }, [initial], current, ['root'], context),
  )
  assert.doesNotThrow(() =>
    index.check({ children: '/data' }, [current], current, ['root'], context, true),
  )
})
