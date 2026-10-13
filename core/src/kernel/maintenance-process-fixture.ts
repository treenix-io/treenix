import { join } from 'node:path';
import { openPersistentWriter } from '#kernel/persistence';
import { createFsStore } from '#kernel/store/fs';
import { scanBudget, storedNode } from '#kernel/store/contract';
import { createWriter } from '#kernel/writer';

const [directory, checkpoint] = process.argv.slice(2);
let now = 1000;
const lease = await openPersistentWriter({
  directory: join(directory, '.treenix'),
  instance: 'test',
});
const store = await createFsStore({
  directory,
  lease,
  external: 'none',
  checkpoint: async (stage) => {
    if (stage === checkpoint) {
      process.send!({ stage });
      await new Promise<void>(() => {});
    }
  },
});
const writer = await createWriter({
  instance: 'test',
  root: store,
  counter: lease,
  writerEpoch: lease.writerEpoch,
  domains: [{ store, epoch: lease.epoch, persistent: true }],
  budget: scanBudget,
  intake: { now: () => now, limits: { opIdWindowMs: 500, clockToleranceMs: 50 } },
  maintenance: { now: () => now, retentionMs: () => 100 },
});

await writer.commit(store, [], (pos) => {
  const node = { ...storedNode('/item'), $pos: pos, value: 9 };
  return {
    writes: [{ path: node.$path, node }],
    record: {
      pos,
      kind: 'commit',
      executor: 'kernel',
      caller: 'kernel',
      entries: [{ path: node.$path, id: node.$id, change: { t: 'create', after: node } }],
    },
  };
});
now = 1130;
await writer.maintain();
throw new Error(`Publication checkpoint was not reached: ${checkpoint}`);
