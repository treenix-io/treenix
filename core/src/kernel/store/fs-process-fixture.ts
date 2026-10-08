import { join } from 'node:path'
import { createInstanceFoundation } from '#kernel/instance'
import { openPersistentWriter } from '#kernel/persistence'
import { createFsStore } from '#kernel/store/fs'
import { scanBudget, storeCommit, storedNode } from '#kernel/store/contract'
import { createWriter } from '#kernel/writer'

const [mode, directory] = process.argv.slice(2)
const lease = await openPersistentWriter({ directory: join(directory, '.treenix'), instance: 'test' })
if (mode === 'lock') {
  process.send!({ type: 'locked', writerEpoch: lease.writerEpoch })
  process.once('message', async () => { await lease.close(); process.disconnect!() })
} else {
  const store = await createFsStore({ directory, lease, checkpoint: mode === 'crash' || mode === 'crash-partial' ? async stage => {
    if (stage === (mode === 'crash' ? 'recordSynced' : 'nodeWritten')) {
      process.send!({ type: stage })
      await new Promise<void>(() => {})
    }
  } : undefined })
  if (mode === 'crash' || mode === 'crash-partial') await store.commit(storeCommit(1, [storedNode('/a', { value: 'complete' }), storedNode('/b', { value: 'complete' })], [], lease.writerEpoch))
  else if (mode === 'writer') {
    const writer = await createWriter({ instance: 'test', root: store, counter: lease, writerEpoch: lease.writerEpoch,
      domains: [{ store, persistent: true, epoch: lease.epoch }], budget: scanBudget })
    const pos = await writer.commit(store, [], pos => ({ writes: [], record: { pos, kind: 'kernel', caller: 'kernel', executor: 'kernel', entries: [] } }))
    process.send!({ type: 'position', pos, writerEpoch: lease.writerEpoch, epoch: lease.epoch })
  } else if (mode === 'instance' || mode === 'instance-reopen') {
    const instance = await createInstanceFoundation({ id: 'test', root: store, counter: lease, writerEpoch: lease.writerEpoch,
      domains: [{ store, persistent: true, epoch: lease.epoch }], budget: scanBudget,
      ...(mode === 'instance' ? { firstAdmin: { path: '/auth/users/admin', name: 'admin', password: 'native-test-password' } } : {}) })
    const account = await instance.source.nodeById(instance.bootstrap.adminId)
    process.send!({ type: 'instance', bootstrap: instance.bootstrap, account, key: await instance.source.node('/sys/auth-key'), pos: instance.writer.position })
  } else {
    process.send!({ type: 'recovered', nodes: (await store.scan({ range: { subtree: '/' }, budget: scanBudget() })).items,
      journal: (await store.scan({ range: { journal: '/' }, budget: scanBudget() })).items })
  }
  await store.close(); await lease.close(); process.disconnect!()
}
