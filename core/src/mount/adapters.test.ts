import { createMemoryTree } from '#tree';
import { KernelError } from '#errors';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import './adapters';
import { type MountCtx, resolveAdapter } from './index';

const ctx: MountCtx = { node: { $path: '/fed', $type: 'dir' }, path: '/fed', parentStore: createMemoryTree() };
const trpc = (url: string, allowPrivate = false) => resolveAdapter({ $type: 't.mount.tree.trpc', url, path: '/', allowPrivate }, ctx);
const isInvalid = (e: unknown) => e instanceof KernelError && e.code === 'INVALID';

describe('t.mount.tree.trpc host guard (F3)', () => {
  it('rejects every spelling of a private host', async () => {
    for (const url of [
      'http://127.0.0.1/', 'http://0x7f000001/', 'http://2130706433/', 'http://127.1/',
      'http://localhost./', 'http://api.localhost/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/',
      'http://[fd00::1]/', 'http://[fe80::1]/', 'http://169.254.169.254/', 'http://10.0.0.1/',
      'http://172.16.0.1/', 'http://192.168.1.1/', 'http://0.0.0.0/',
    ]) {
      await assert.rejects(() => trpc(url), isInvalid, url);
    }
  });

  it('accepts a public host, and a private one with allowPrivate', async () => {
    assert.ok(await trpc('https://peer.example.com/trpc'));
    assert.ok(await trpc('http://127.0.0.1:3211/trpc', true));
  });

  it('rejects an unparseable url without echoing it', async () => {
    await assert.rejects(() => trpc('https://user:TOKEN@'), (e) => isInvalid(e) && e instanceof KernelError && !e.message.includes('TOKEN'));
  });
});
