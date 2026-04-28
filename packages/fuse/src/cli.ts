#!/usr/bin/env tsx
// CLI: treenix-mount <mountpoint> [--url=http://localhost:3211] [--token=...] [--debug]

import { createFuseMount } from '#index';
import { createTrpcTransport } from '@treenx/core/client';
import { mkdir } from 'node:fs/promises';

const args = process.argv.slice(2);
const flags = Object.fromEntries(
  args.filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.slice(2).split('=');
    return [k, v ?? 'true'];
  }),
);
const positional = args.filter(a => !a.startsWith('--'));

const mountpoint = positional[0];
if (!mountpoint) {
  console.error('Usage: treenix-mount <mountpoint> [--url=http://localhost:3211] [--token=...] [--debug]');
  process.exit(1);
}

const url = flags.url ?? 'http://localhost:3211';
const token = flags.token;
const debug = 'debug' in flags;

await mkdir(mountpoint, { recursive: true });

const client = createTrpcTransport({ url, token });
const mount = createFuseMount({ client, mountpoint, debug });

await mount.mount();

// Graceful shutdown
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    console.log(`\n[fuse] ${sig}, unmounting...`);
    await mount.unmount();
    process.exit(0);
  });
}

console.log(`[fuse] tree @ ${url} → ${mountpoint}`);
console.log('[fuse] Ctrl+C to unmount');
