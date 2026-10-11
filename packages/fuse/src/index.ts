// Every node is a directory; $.json exposes its native projected data.
import { constants } from 'node:fs'
import { KernelError } from '@treenx/core/errors'
import type { TwpClient } from '@treenx/core/client/twp'
import type { Node } from '@treenx/core/kernel/types'
import { isNodeInput } from '@treenx/core/protocol/twp'

const errno = { missing: 2, io: 5, denied: 13, directory: 21, invalid: 22, conflict: 11 }

interface OpenFile {
  node: Node
  bytes: Buffer
  dirty: boolean
}

/** Resolve the projected JSON file without changing the directory namespace. */
function target(path: string): { node: string; json: boolean } {
  return path.endsWith('/$.json')
    ? { node: path.slice(0, -7) || '/', json: true }
    : { node: path, json: false }
}

/** Preserve native failures as filesystem errors at the external callback boundary. */
export function fuseError(error: unknown): number {
  if (!(error instanceof KernelError)) {
    console.error(error)
    return -errno.io
  }

  switch (error.code) {
    case 'NOT_FOUND': return -errno.missing
    case 'FORBIDDEN': case 'REFUSED': case 'UNAUTHENTICATED': return -errno.denied
    case 'CONFLICT': return -errno.conflict
    case 'INVALID': return -errno.invalid
    default: return -errno.io
  }
}

/** Own open handles; accepted writes enter the kernel as one revision-checked commit. */
export function createFuseOperations(client: TwpClient) {
  const files = new Map<number, OpenFile>()
  let nextHandle = 1
  let closed = false

  function active(): void {
    if (closed) throw new KernelError('UNAVAILABLE', 'Filesystem is closed')
  }

  async function node(path: string): Promise<Node> {
    active()
    const result = await client.read({ node: path })
    const copy = result.copies[0]
    if ('error' in copy) throw copy.error
    return copy.node
  }

  function file(fd: number): OpenFile {
    active()
    const opened = files.get(fd)
    if (opened === undefined) throw new KernelError('INVALID', 'File handle is absent')
    return opened
  }

  function bytes(value: Node): Buffer {
    return Buffer.from(JSON.stringify(value, null, 2) + '\n')
  }

  async function flush(fd: number): Promise<void> {
    const opened = file(fd)
    if (!opened.dirty) return
    const input: unknown = JSON.parse(opened.bytes.toString('utf8'))
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new KernelError('INVALID', 'Node JSON must be an object')
    }
    const fields: Record<string, unknown> = { ...input }
    delete fields.$id
    delete fields.$rev
    const replacement = { ...fields, $path: opened.node.$path }
    if (!isNodeInput(replacement)) throw new KernelError('INVALID', 'Malformed node JSON')

    await client.commit({
      changes: [{ op: 'put', node: replacement }],
      expect: { nodes: [{ path: opened.node.$path, rev: opened.node.$rev }] },
    }).outcome
    opened.dirty = false
    opened.node = await node(opened.node.$path)
  }

  return {
    async getattr(path: string) {
      const at = target(path), value = await node(at.node)
      const now = new Date()

      return {
        mode: at.json ? 0o100644 : 0o40755,
        size: at.json ? bytes(value).length : 0,
        uid: process.getuid?.() ?? 0,
        gid: process.getgid?.() ?? 0,
        mtime: now,
        atime: now,
        ctime: now,
      }
    },
    async readdir(path: string): Promise<string[]> {
      await node(path)
      const result = await client.read({ children: path })
      return ['.', '..', '$.json', ...result.copies.map(copy => {
        if ('error' in copy) throw copy.error
        return copy.node.$path.slice(copy.node.$path.lastIndexOf('/') + 1)
      })]
    },
    async open(path: string, flags = 0): Promise<number> {
      const at = target(path)
      if (!at.json) throw new KernelError('INVALID', 'Directory cannot be opened as JSON')
      const value = await node(at.node), fd = nextHandle++
      files.set(fd, { node: value, bytes: flags & constants.O_TRUNC ? Buffer.alloc(0) : bytes(value), dirty: false })
      return fd
    },
    async read(fd: number, buffer: Buffer, length: number, offset: number): Promise<number> {
      return file(fd).bytes.copy(buffer, 0, offset, offset + length)
    },
    async write(fd: number, buffer: Buffer, length: number, offset: number): Promise<number> {
      const opened = file(fd)
      if (offset < 0 || length < 0 || length > buffer.length) throw new KernelError('INVALID', 'Invalid write range')
      const end = offset + length
      if (end > opened.bytes.length) {
        const extended = Buffer.alloc(end)
        opened.bytes.copy(extended)
        opened.bytes = extended
      }
      buffer.copy(opened.bytes, offset, 0, length)
      opened.dirty = true
      return length
    },
    async truncate(path: string, size: number): Promise<void> {
      const at = target(path)
      if (!at.json || size < 0) throw new KernelError('INVALID', 'Invalid truncate')
      await node(at.node)
      if (![...files.values()].some(opened => opened.node.$path === at.node)) {
        throw new KernelError('INVALID', 'Truncate requires an open node JSON file')
      }
      // The FUSE truncate callback has no fd; all open handles at this path observe it.
      for (const opened of files.values()) if (opened.node.$path === at.node) {
        const replacement = Buffer.alloc(size)
        opened.bytes.copy(replacement)
        opened.bytes = replacement
        opened.dirty = true
      }
    },
    flush,
    async release(fd: number): Promise<void> {
      try {
        await flush(fd)
      } finally {
        files.delete(fd)
      }
    },
    async mkdir(path: string): Promise<void> {
      active()
      await client.commit({
        changes: [{ op: 'put', node: { $path: path, $type: 't.dir' } }],
        expect: { absent: [path] },
      }).outcome
    },
    async rmdir(path: string): Promise<void> {
      const value = await node(path)
      await client.commit({
        changes: [{ op: 'remove', path }],
        expect: { nodes: [{ path, rev: value.$rev }] },
      }).outcome
    },
    async rename(from: string, to: string): Promise<void> {
      if (target(from).json || target(to).json) throw new KernelError('FORBIDDEN', 'Node JSON cannot be renamed')
      const value = await node(from)
      await client.commit({
        changes: [{ op: 'move', from, to }],
        expect: { nodes: [{ path: from, rev: value.$rev }], absent: [to] },
      }).outcome
    },
    close(): void {
      if (closed) return

      closed = true
      files.clear()
      client.close()
    }
  }
}

export interface MountOpts {
  readonly client: TwpClient
  readonly mountpoint: string
  readonly debug?: boolean
}

/** Load the native binding only when mounting and close the owned transport on every terminal path. */
export function createFuseMount(options: MountOpts) {
  const operations = createFuseOperations(options.client)
  let binding: import('fuse-native').default | undefined

  return {
    operations,
    async mount(): Promise<void> {
      try {
        const { default: Fuse } = await import('fuse-native')
        const done = (callback: (code: number) => void, work: Promise<void>) => {
          work.then(() => callback(0), error => callback(fuseError(error)))
        }
        binding = new Fuse(options.mountpoint, {
          getattr(path, callback) { operations.getattr(path).then(value => callback(0, value), error => callback(fuseError(error))) },
          readdir(path, callback) { operations.readdir(path).then(value => callback(0, value), error => callback(fuseError(error))) },
          open(path, flags, callback) {
            if (!target(path).json) { callback(-errno.directory); return }
            operations.open(path, flags).then(fd => callback(0, fd), error => callback(fuseError(error)))
          },
          read(_path, fd, buffer, length, offset, callback) {
            operations.read(fd, buffer, length, offset).then(count => callback(count), error => callback(fuseError(error)))
          },
          write(_path, fd, buffer, length, offset, callback) {
            operations.write(fd, buffer, length, offset).then(count => callback(count), error => callback(fuseError(error)))
          },
          truncate(path, size, callback) { done(callback, operations.truncate(path, size)) },
          flush(_path, fd, callback) { done(callback, operations.flush(fd)) },
          fsync(_path, fd, _datasync, callback) { done(callback, operations.flush(fd)) },
          release(_path, fd, callback) { done(callback, operations.release(fd)) },
          mkdir(path, _mode, callback) { done(callback, operations.mkdir(path)) },
          rmdir(path, callback) { done(callback, operations.rmdir(path)) },
          rename(from, to, callback) { done(callback, operations.rename(from, to)) },
          unlink(_path, callback) { callback(-errno.denied) }
        }, { debug: options.debug, autoUnmount: true })
        const mounted = binding
        await new Promise<void>((resolve, reject) => mounted.mount(error => error ? reject(error) : resolve()))
      } catch (error) {
        operations.close()
        throw error
      }
    },
    async close(): Promise<void> {
      try {
        const mounted = binding
        binding = undefined
        if (mounted !== undefined) await new Promise<void>((resolve, reject) => mounted.unmount(error => error ? reject(error) : resolve()))
      } finally {
        operations.close()
      }
    }
  }
}
