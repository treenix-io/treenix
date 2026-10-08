import { join } from 'node:path'

import { openPersistentWriter } from '#kernel/persistence'
import { storeCommit, storedNode } from '#kernel/store/contract'
import { createFsStore } from '#kernel/store/fs'

const [directory, stopAt] = process.argv.slice(2)
const lease = await openPersistentWriter({ directory: join(directory, '.treenix'), instance: 'test' })
const options = { directory, lease, logicalBase: '/mounted', async checkpoint(stage: string) {
  if (stage === stopAt) {
    process.send!({ stage })
    await new Promise<void>(() => {})
  }
} }
const store = await createFsStore(options)
await store.commit(storeCommit(1, [storedNode('/mounted/a', { value: 'complete' }),
  storedNode('/mounted/b', { value: 'complete' })], [], lease.writerEpoch))
await store.close()
await lease.close()
process.disconnect!()
