import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { treeEnsure, treeNavigate, treeRemove, treeWalk, type TreeNode } from './nested-map'

describe('nested path index deletion', () => {
  it('walks data and virtual parent nodes once each', () => {
    const root: TreeNode<string> = { data: 'root', children: new Map() }
    treeEnsure(root, '/a/x').data = 'leaf'
    const nodes = [...treeWalk(root)]
    assert.equal(nodes.length, 3)
    assert.equal(nodes[0], root)
    assert.deepEqual(nodes.map(node => node.data), ['root', undefined, 'leaf'])
  })

  it('prunes an empty branch while preserving sibling data', () => {
    const root: TreeNode<string> = { children: new Map() }
    treeEnsure(root, '/a/x').data = 'a'
    treeEnsure(root, '/b').data = 'b'
    treeRemove(root, '/a/x')
    assert.equal(treeNavigate(root, '/a'), undefined)
    assert.equal(treeNavigate(root, '/b')?.data, 'b')
    treeRemove(root, '/b')
    assert.equal(root.children.size, 0)
  })

  it('preserves descendants when their parent data is removed', () => {
    const root: TreeNode<string> = { children: new Map() }
    treeEnsure(root, '/a').data = 'parent'
    treeEnsure(root, '/a/x').data = 'child'
    treeRemove(root, '/a')
    assert.equal(treeNavigate(root, '/a')?.data, undefined)
    assert.equal(treeNavigate(root, '/a/x')?.data, 'child')
  })

  it('removes root data without deleting children and tolerates missing paths', () => {
    const root: TreeNode<string> = { data: 'root', children: new Map() }
    treeEnsure(root, '/a').data = 'child'
    treeRemove(root, '/')
    treeRemove(root, '/missing/path')
    assert.equal(root.data, undefined)
    assert.equal(treeNavigate(root, '/a')?.data, 'child')
  })
})
