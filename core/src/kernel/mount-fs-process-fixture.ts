import assert from 'node:assert/strict'

import { openFsMountTarget } from '#kernel/mount-fs'
import { scanBudget, storeCommit, storedNode } from '#kernel/store/contract'

const [mode, directory] = process.argv.slice(2)
const target = await openFsMountTarget({ directory, instance: 'test', logicalBase: '/mounted' })
const opId = { epoch: 'previous-intake', time: 1, nonce: 'operation' }

if (mode === 'seed') {
  const commit = storeCommit(1, [{ ...storedNode('/mounted/doc', { value: 'accepted' }), $id: 'p:/mounted/doc' }], [], target.resources.writerEpoch)
  await target.store.commit({
    ...commit,
    record: {
      ...commit.record,
      caller: 'u:admin',
      decision: { opId, requestHash: 'request', outcome: { pos: commit.pos, value: 'canonical' } },
    },
  })
}

assert.ok(process.send)
process.send({
  type: mode,
  domain: target.store.domain,
  resources: target.resources,
  nodes: (await target.store.scan({ range: { subtree: '/mounted' }, budget: scanBudget() })).items,
  decision: (await target.store.scan({ range: { decision: { caller: 'u:admin', opId } }, budget: scanBudget() })).items,
})

if (mode === 'hold') {
  await new Promise<void>(resolve => process.once('message', resolve))
}

await target.close()
assert.ok(process.disconnect)
process.disconnect()
