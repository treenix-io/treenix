import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createTestInstance } from '#kernel/testing'
import { createTestInstance as directFactory, scanBudget, storedNode } from '@treenx/core/kernel/testing'
import type { CreateTestInstance } from '@treenx/core/kernel/types'

it('publishes the genuine factory and preserves Store helper exports through package entry points', async () => {
  const factory: CreateTestInstance = createTestInstance
  assert.equal(factory, directFactory)
  assert.equal(scanBudget().nodes, 1000)
  assert.equal(storedNode('/package').$path, '/package')
  const instance = await directFactory({ modules: [], seed: [], actors: { visitor: { kind: 'credential' } } })
  try { assert.ok(instance.actors.visitor.actor.principal.startsWith('anon:')) }
  finally { await instance.close() }
})
