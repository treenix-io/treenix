// Treenix FUSE mount — expose tree as a filesystem via libfuse FFI.
// Every node = directory. $.json = node data. Children = subdirs.
// Read-write: read $.json, write $.json, mkdir = create node, rmdir = remove node.

import type { NodeData } from '@treenx/core';
import type { TreenixClient } from '@treenx/core/client';
import koffi from 'koffi';

// --- libfuse FFI bindings ---

const FUSE_LIB = process.platform === 'darwin' ? '/usr/local/lib/libfuse.dylib' : 'libfuse.so.2';
const lib = koffi.load(FUSE_LIB);

// errno codes
const ENOENT = 2;
const EIO = 5;
const EACCES = 13;
const EISDIR = 21;
const ENOTEMPTY = 66;

// stat struct (macOS)
const StatStruct = koffi.struct('stat', {
  st_dev: 'int32',
  st_mode: 'uint16',
  st_nlink: 'uint16',
  st_ino: 'uint64',
  st_uid: 'uint32',
  st_gid: 'uint32',
  st_rdev: 'int32',
  st_atimespec: koffi.struct({ tv_sec: 'int64', tv_nsec: 'int64' }),
  st_mtimespec: koffi.struct({ tv_sec: 'int64', tv_nsec: 'int64' }),
  st_ctimespec: koffi.struct({ tv_sec: 'int64', tv_nsec: 'int64' }),
  st_birthtimespec: koffi.struct({ tv_sec: 'int64', tv_nsec: 'int64' }),
  st_size: 'int64',
  st_blocks: 'int64',
  st_blksize: 'int32',
  st_flags: 'uint32',
  st_gen: 'uint32',
  st_lspare: 'int32',
  st_qspare: koffi.array('int64', 2),
});

// fuse_fill_dir_t: int (*)(void *buf, const char *name, const struct stat *stbuf, off_t off)
const FillDirCb = koffi.proto('int fuse_fill_dir_t(void *buf, const char *name, void *stbuf, int64 off)');

// fuse_operations callbacks we implement
const GetAttrCb = koffi.proto('int fuse_getattr_cb(const char *path, _Out_ stat *stbuf)');
const ReadDirCb = koffi.proto('int fuse_readdir_cb(const char *path, void *buf, fuse_fill_dir_t *filler, int64 offset, void *fi)');
const OpenCb = koffi.proto('int fuse_open_cb(const char *path, void *fi)');
const ReadCb = koffi.proto('int fuse_read_cb(const char *path, _Out_ uint8 *buf, uint64 size, int64 offset, void *fi)');
const WriteCb = koffi.proto('int fuse_write_cb(const char *path, const uint8 *buf, uint64 size, int64 offset, void *fi)');
const MkdirCb = koffi.proto('int fuse_mkdir_cb(const char *path, uint32 mode)');
const RmdirCb = koffi.proto('int fuse_rmdir_cb(const char *path)');
const UnlinkCb = koffi.proto('int fuse_unlink_cb(const char *path)');
const TruncateCb = koffi.proto('int fuse_truncate_cb(const char *path, int64 size)');
const ReleaseCb = koffi.proto('int fuse_release_cb(const char *path, void *fi)');

const FuseOperations = koffi.struct('fuse_operations', {
  getattr: koffi.pointer(GetAttrCb),
  readlink: 'void *',
  getdir: 'void *',
  mknod: 'void *',
  mkdir: koffi.pointer(MkdirCb),
  unlink: koffi.pointer(UnlinkCb),
  rmdir: koffi.pointer(RmdirCb),
  symlink: 'void *',
  rename: 'void *',
  link: 'void *',
  chmod: 'void *',
  chown: 'void *',
  truncate: koffi.pointer(TruncateCb),
  utime: 'void *',
  open: koffi.pointer(OpenCb),
  read: koffi.pointer(ReadCb),
  write: koffi.pointer(WriteCb),
  statfs: 'void *',
  flush: 'void *',
  release: koffi.pointer(ReleaseCb),
  fsync: 'void *',
  setxattr: 'void *',
  getxattr: 'void *',
  listxattr: 'void *',
  removexattr: 'void *',
  opendir: 'void *',
  readdir: koffi.pointer(ReadDirCb),
  releasedir: 'void *',
  fsyncdir: 'void *',
  init: 'void *',
  destroy: 'void *',
  access: 'void *',
  create: 'void *',
  ftruncate: 'void *',
  fgetattr: 'void *',
});

// int fuse_main_real(int argc, char *argv[], const struct fuse_operations *op, size_t op_size, void *user_data)
const fuse_main_real = lib.func('int fuse_main_real(int argc, const char **argv, fuse_operations *op, uint64 op_size, void *user_data)');

// --- Cache ---

const CACHE_TTL = 2000;
type CacheEntry<T> = { value: T; ts: number };

function createCache<T>() {
  const map = new Map<string, CacheEntry<T>>();
  return {
    get(key: string): T | undefined {
      const entry = map.get(key);
      if (!entry) return undefined;
      if (Date.now() - entry.ts > CACHE_TTL) { map.delete(key); return undefined; }
      return entry.value;
    },
    set(key: string, value: T) { map.set(key, { value, ts: Date.now() }); },
    invalidate(key: string) { map.delete(key); },
  };
}

// --- Path parsing ---

function parsePath(fusePath: string): { treePath: string; isData: boolean } {
  if (fusePath === '/') return { treePath: '/', isData: false };
  if (fusePath.endsWith('/$.json')) return { treePath: fusePath.slice(0, -7) || '/', isData: true };
  if (fusePath === '/$.json') return { treePath: '/', isData: true };
  return { treePath: fusePath, isData: false };
}

// --- Mount ---

export type MountOpts = {
  client: TreenixClient;
  mountpoint: string;
  debug?: boolean;
};

// Write buffer accumulation per path (FUSE may split writes into chunks)
type WriteBuf = { chunks: Buffer[]; totalLen: number };

export function createFuseMount({ client, mountpoint, debug }: MountOpts) {
  const { tree } = client;
  const nodeCache = createCache<NodeData | null>();
  const childrenCache = createCache<string[]>();
  const writeBufs = new Map<string, WriteBuf>();

  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const now = Math.floor(Date.now() / 1000);

  async function getNode(treePath: string): Promise<NodeData | null> {
    const cached = nodeCache.get(treePath);
    if (cached !== undefined) return cached;
    const node = (await tree.get(treePath)) ?? null;
    nodeCache.set(treePath, node);
    return node;
  }

  async function getChildNames(treePath: string): Promise<string[]> {
    const cached = childrenCache.get(treePath);
    if (cached !== undefined) return cached;
    const page = await tree.getChildren(treePath, { depth: 1 });
    const names = page.items.map(n => n.$path.slice(n.$path.lastIndexOf('/') + 1));
    childrenCache.set(treePath, names);
    return names;
  }

  function fillStat(stbuf: Record<string, unknown>, mode: number, size: number) {
    stbuf.st_mode = mode;
    stbuf.st_nlink = mode & 0o40000 ? 2 : 1;
    stbuf.st_uid = uid;
    stbuf.st_gid = gid;
    stbuf.st_size = size;
    stbuf.st_atimespec = { tv_sec: now, tv_nsec: 0 };
    stbuf.st_mtimespec = { tv_sec: now, tv_nsec: 0 };
    stbuf.st_ctimespec = { tv_sec: now, tv_nsec: 0 };
  }

  // Wrap async handler — fuse callbacks must be sync, so we block via Atomics
  // Actually koffi supports async callbacks natively, but fuse_main blocks the thread.
  // We'll use a pending-result pattern with koffi.async

  // Since fuse_main_real blocks, all our callbacks run on the FUSE thread.
  // koffi handles async JS callbacks by blocking the native thread until the JS promise resolves.

  const ops: InstanceType<typeof FuseOperations.constructor> = {
    getattr: koffi.register((path: string, stbuf: Record<string, unknown>) => {
      const { treePath, isData } = parsePath(path);

      return getNode(treePath).then(node => {
        if (!node) return -ENOENT;

        if (isData) {
          const size = Buffer.byteLength(JSON.stringify(node, null, 2) + '\n');
          fillStat(stbuf, 0o100644, size);
        } else {
          fillStat(stbuf, 0o40755, 4096);
        }
        return 0;
      }).catch(e => {
        if (debug) console.error('[fuse] getattr error:', path, e);
        return -EIO;
      });
    }, koffi.pointer(GetAttrCb)),

    readdir: koffi.register((path: string, buf: unknown, filler: Function, offset: number, fi: unknown) => {
      const { treePath } = parsePath(path);

      return getNode(treePath).then(async node => {
        if (!node) return -ENOENT;
        filler(buf, '.', null, 0);
        filler(buf, '..', null, 0);
        filler(buf, '$.json', null, 0);

        const names = await getChildNames(treePath);
        for (const name of names) filler(buf, name, null, 0);
        return 0;
      }).catch(e => {
        if (debug) console.error('[fuse] readdir error:', path, e);
        return -EIO;
      });
    }, koffi.pointer(ReadDirCb)),

    open: koffi.register((path: string, fi: unknown) => {
      const { treePath, isData } = parsePath(path);
      if (!isData) return -EISDIR;

      return getNode(treePath).then(node => {
        if (!node) return -ENOENT;
        return 0;
      }).catch(() => -EIO);
    }, koffi.pointer(OpenCb)),

    read: koffi.register((path: string, buf: Buffer, size: number, offset: number, fi: unknown) => {
      const { treePath, isData } = parsePath(path);
      if (!isData) return -EISDIR;

      return getNode(treePath).then(node => {
        if (!node) return -ENOENT;
        const data = Buffer.from(JSON.stringify(node, null, 2) + '\n');
        if (offset >= data.length) return 0;
        const end = Math.min(offset + size, data.length);
        data.copy(buf, 0, offset, end);
        return end - offset;
      }).catch(e => {
        if (debug) console.error('[fuse] read error:', path, e);
        return -EIO;
      });
    }, koffi.pointer(ReadCb)),

    write: koffi.register((path: string, buf: Buffer, size: number, offset: number, fi: unknown) => {
      const { treePath, isData } = parsePath(path);
      if (!isData) return -EACCES;

      // Accumulate write chunks
      let wb = writeBufs.get(treePath);
      if (!wb || offset === 0) {
        wb = { chunks: [], totalLen: 0 };
        writeBufs.set(treePath, wb);
      }
      wb.chunks.push(Buffer.from(buf.slice(0, size)));
      wb.totalLen += size;
      return size;
    }, koffi.pointer(WriteCb)),

    // Flush accumulated writes on release
    release: koffi.register((path: string, fi: unknown) => {
      const { treePath, isData } = parsePath(path);
      if (!isData) return 0;

      const wb = writeBufs.get(treePath);
      if (!wb) return 0;
      writeBufs.delete(treePath);

      const json = Buffer.concat(wb.chunks).toString('utf-8').trim();
      if (!json) return 0;

      return Promise.resolve().then(async () => {
        const node = JSON.parse(json) as NodeData;
        if (node.$path !== treePath) node.$path = treePath;
        await tree.set(node);
        nodeCache.invalidate(treePath);
        const parentPath = treePath.slice(0, treePath.lastIndexOf('/')) || '/';
        childrenCache.invalidate(parentPath);
        return 0;
      }).catch(e => {
        if (debug) console.error('[fuse] release/write error:', path, e);
        return -EIO;
      });
    }, koffi.pointer(ReleaseCb)),

    mkdir: koffi.register((path: string, mode: number) => {
      const { treePath } = parsePath(path);
      return tree.set({ $path: treePath, $type: 'dir' } as NodeData).then(() => {
        nodeCache.invalidate(treePath);
        const parentPath = treePath.slice(0, treePath.lastIndexOf('/')) || '/';
        childrenCache.invalidate(parentPath);
        return 0;
      }).catch(e => {
        if (debug) console.error('[fuse] mkdir error:', path, e);
        return -EIO;
      });
    }, koffi.pointer(MkdirCb)),

    rmdir: koffi.register((path: string) => {
      const { treePath } = parsePath(path);
      return tree.remove(treePath).then(() => {
        nodeCache.invalidate(treePath);
        const parentPath = treePath.slice(0, treePath.lastIndexOf('/')) || '/';
        childrenCache.invalidate(parentPath);
        return 0;
      }).catch(e => {
        if (debug) console.error('[fuse] rmdir error:', path, e);
        return -EIO;
      });
    }, koffi.pointer(RmdirCb)),

    unlink: koffi.register((path: string) => -EACCES, koffi.pointer(UnlinkCb)),

    truncate: koffi.register((path: string, size: number) => {
      const { treePath } = parsePath(path);
      // Reset write buffer on truncate(0)
      if (size === 0) writeBufs.delete(treePath);
      return 0;
    }, koffi.pointer(TruncateCb)),

    // Null out unused ops
    readlink: null, getdir: null, mknod: null, symlink: null, rename: null,
    link: null, chmod: null, chown: null, utime: null, statfs: null,
    flush: null, fsync: null, setxattr: null, getxattr: null,
    listxattr: null, removexattr: null, opendir: null, releasedir: null,
    fsyncdir: null, init: null, destroy: null, access: null, create: null,
    ftruncate: null, fgetattr: null,
  };

  return {
    mount(extraArgs: string[] = []) {
      const argv = ['treenix-fuse', mountpoint, '-f', '-s', ...extraArgs];
      if (debug) argv.push('-d');

      console.log(`[fuse] mounting tree → ${mountpoint}`);

      // fuse_main blocks — run in a worker or just let it take the main thread
      const code = fuse_main_real(argv.length, argv, ops, koffi.sizeof(FuseOperations), null);
      if (code !== 0) throw new Error(`fuse_main exited with code ${code}`);
    },
  };
}
