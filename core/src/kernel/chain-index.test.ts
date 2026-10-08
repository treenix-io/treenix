import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createChainIndex } from '#kernel/chain-index'

it('indexes direct child metadata through replacement, deletion and missing parents', () => {
  const index = createChainIndex()
  const node = (path: string, id = path) => ({ $path: path, $id: id, $type: 'item' })
  index.put(node('/p/a')); index.put(node('/p/b')); index.put(node('/p/a/nested')); index.put(node('/else/a'))
  assert.deepEqual([...index.children('/p')].map(child => child.path), ['/p/a', '/p/b'])
  index.put(node('/p/a', 'replacement'))
  assert.deepEqual([...index.children('/p')].map(child => child.id), ['replacement', '/p/b'])
  index.remove('/p/a')
  assert.deepEqual([...index.children('/p')].map(child => child.path), ['/p/b'])
  assert.deepEqual([...index.children('/p/a')].map(child => child.path), ['/p/a/nested'])
  index.put(node('/new/a/nested')); index.remove('/p/a/nested')
  assert.deepEqual([...index.children('/p/a')], [])
  assert.deepEqual([...index.children('/new/a')].map(child => child.path), ['/new/a/nested'])
})
