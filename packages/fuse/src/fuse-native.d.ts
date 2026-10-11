declare module 'fuse-native' {
  interface Stat { mode: number; size: number; uid: number; gid: number; mtime: Date; atime: Date; ctime: Date }
  type Done = (code: number) => void
  interface Operations {
    getattr(path: string, done: (code: number, stat?: Stat) => void): void
    readdir(path: string, done: (code: number, names?: string[]) => void): void
    open(path: string, flags: number, done: (code: number, fd?: number) => void): void
    read(path: string, fd: number, buffer: Buffer, length: number, offset: number, done: Done): void
    write(path: string, fd: number, buffer: Buffer, length: number, offset: number, done: Done): void
    truncate(path: string, size: number, done: Done): void
    flush(path: string, fd: number, done: Done): void
    fsync(path: string, fd: number, datasync: boolean, done: Done): void
    release(path: string, fd: number, done: Done): void
    mkdir(path: string, mode: number, done: Done): void
    rmdir(path: string, done: Done): void
    rename(from: string, to: string, done: Done): void
    unlink(path: string, done: Done): void
  }
  export default class Fuse {
    constructor(path: string, operations: Operations, options: { debug?: boolean; autoUnmount?: boolean })
    mount(done: (error?: Error | null) => void): void
    unmount(done: (error?: Error | null) => void): void
  }
}
