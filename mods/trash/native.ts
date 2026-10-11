import { KernelError } from '@treenx/core/errors'
import { DEFAULT_LIMITS, type JournalAddress, type ModuleManifest, type Row } from '@treenx/core/kernel/types'

/** Declassified deletion history issued by the Trash View. */
export interface TrashRow extends Row {
  readonly address: JournalAddress
  readonly path: string
}

function address(input: unknown): JournalAddress {
  if (input === null || typeof input !== 'object') throw new KernelError('INVALID', 'Expected a journal address')

  const id = Reflect.get(input, 'id'), pos = Reflect.get(input, 'pos')
  if (typeof id !== 'string' || pos === null || typeof pos !== 'object')
    throw new KernelError('INVALID', 'Expected a journal address')

  const instance = Reflect.get(pos, 'instance'), epoch = Reflect.get(pos, 'epoch'), seq = Reflect.get(pos, 'seq')
  if (typeof instance !== 'string' || typeof epoch !== 'number' || typeof seq !== 'number'
    || !Number.isSafeInteger(epoch) || !Number.isSafeInteger(seq))
    throw new KernelError('INVALID', 'Expected a journal position')

  return { id, pos: { instance, epoch, seq } }
}

/** Exposes retained deletion history and scoped restore and undo actions. */
export function createTrashManifest(scope = '/'): ModuleManifest {
  return {
    id: 'trash', open: [],
    types: [{ name: 't.mount.trash', module: 'trash', version: 0, security: 'privileged-capability',
      schema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
      actions: { restore: { kind: 'write', args: { type: 'object' }, needs: { history: { history: scope } },
        async handler(ctx, input) {
          const wanted = address(input)
          const history = ctx.needs.history.history!
          const entry = history.find(item => item.kind === 'commit' && item.after === null
            && item.before !== null && item.before !== 'unknown' && item.address.id === wanted.id
            && item.address.pos.instance === wanted.pos.instance && item.address.pos.epoch === wanted.pos.epoch
            && item.address.pos.seq === wanted.pos.seq)
          if (entry === undefined) throw new KernelError('NOT_FOUND', 'Deletion is absent from visible history')
          ctx.change.restore(entry.address)
        } }, undo: { kind: 'write', args: { type: 'array' },
        async *handler(ctx, input) {
          if (!Array.isArray(input)) throw new KernelError('INVALID', 'Expected journal addresses')
          const history = (await ctx.read.read({ history: scope })).history!
          const selected = input.map(value => {
            const wanted = address(value)
            const entry = history.find(item => item.kind === 'commit' && item.address.id === wanted.id
              && item.address.pos.instance === wanted.pos.instance && item.address.pos.epoch === wanted.pos.epoch
              && item.address.pos.seq === wanted.pos.seq)
            if (entry === undefined) throw new KernelError('NOT_FOUND', 'Change is absent from visible history')
            return entry
          })
          if (selected.every(entry => entry.after === null && entry.before !== null && entry.before !== 'unknown'))
            selected.sort((a, b) => a.path.split('/').length - b.path.split('/').length)
          else selected.sort((a, b) => b.address.pos.epoch - a.address.pos.epoch || b.address.pos.seq - a.address.pos.seq)
          let offset = 0
          while (offset < selected.length) {
            const seen = new Set<string>()
            let count = 0
            while (offset < selected.length && count < DEFAULT_LIMITS.changeSet) {
              const entry = selected[offset]
              if (seen.has(entry.address.id)) break
              seen.add(entry.address.id)
              ctx.change.undo(entry.address)
              offset++; count++
            }
            yield { reversed: offset }
          }
        } } } }],
    security: [{ type: 't.mount.trash', context: 'mount', async handler() {
      return { kind: 'view', executor: 'reader', async derive(_node, _request, reader) {
        const history = (await reader.read({ history: scope })).history!
        const rows: TrashRow[] = []
        for (const entry of history) if (entry.kind === 'commit' && entry.after === null
          && entry.before !== null && entry.before !== 'unknown') {
          rows.push({ key: JSON.stringify(entry.address), address: entry.address, path: entry.before.$path })
        }
        return { members: [], rows }
      }, async close() {} }
    } }],
  }
}
