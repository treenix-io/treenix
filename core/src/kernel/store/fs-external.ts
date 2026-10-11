import { watch } from 'node:fs'
import { KernelError } from '#errors'
import { fsAddress } from './fs-layout'
import { DEFAULT_LIMITS, type Path } from '#kernel/types'

/** Coalesce actual filesystem notifications; the single owner drains and closes the watcher. */
export function createFsExternalWatcher(directory: string, logical: (path: Path) => Path, initial: readonly Path[]) {
  const pending = new Set(initial)
  let closed = false
  let failure: unknown
  let wake = () => {}
  const watcher = watch(directory, { recursive: true }, (_event, filename) => {
    if (failure !== undefined || closed) return
    try {
      const path = filename === null ? '' : filename.toString()
      const parts = path.split('/')
      if (parts[0] === '.treenix' || parts[0] === '.git') return
      const name = parts.at(-1)!
      if (name.startsWith('.') && name.endsWith('.tmp')) return
      const address = filename === null ? '/' : name === '$' || name === '$.json' ? `/${parts.slice(0, -1).join('/')}`
        : name.endsWith('.json') ? `/${path.slice(0, -5)}` : `/${path}`
      fsAddress(address)
      const mapped = logical(address)
      if (!pending.has(mapped) && pending.size >= DEFAULT_LIMITS.readNodes)
        throw new KernelError('BUDGET', 'Filesystem external notification budget exceeded')
      pending.add(mapped)
      wake()
    } catch (error) { refuse(error) }
  })
  /** Stop retaining addresses immediately after the reporting resource fails. */
  function refuse(error: unknown): void {
    if (failure !== undefined) return
    failure = error
    pending.clear()
    watcher.close()
    wake()
  }
  watcher.on('error', refuse)

  /** Read one coalesced batch without retaining historical events. */
  async function* events(signal?: AbortSignal): AsyncGenerator<readonly Path[]> {
    const abort = () => { failure = signal!.reason; wake() }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    try {
      while (!closed) {
        if (failure !== undefined) throw failure
        if (pending.size === 0) await new Promise<void>(resolve => { wake = resolve })
        if (failure !== undefined) throw failure
        if (closed) return
        const paths = [...pending]
        pending.clear()
        yield paths
      }
    } finally { signal?.removeEventListener('abort', abort); close() }
  }

  /** Release the actual OS watch before an owner waits for its consumer. */
  function close(): void {
    if (closed) return
    closed = true
    watcher.close()
    wake()
  }
  return { events, close }
}
