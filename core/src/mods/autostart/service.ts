// Autostart — service coordinator with dynamic start/stop
// Walks children at boot, tracks handles, exposes start/stop actions
// Tree = truth: ref child exists ↔ service is running

import { registerType } from '#comp';
import { type ServiceCtx, type ServiceHandle } from '#contexts/service/index';
import { isRef, type NodeData, register, resolve as coreResolve } from '#core';
import { resolveRef } from '#tree';

// ── Module-scope service tracking ──

const handles = new Map<string, ServiceHandle>();
let _svcCtx: ServiceCtx | null = null;
let _autostartPath = '/sys/autostart';

async function _startService(path: string): Promise<void> {
  if (handles.has(path)) return;
  if (!_svcCtx) throw new Error('autostart: not initialized');

  const node = await _svcCtx.store.get(path);
  if (!node) throw new Error(`autostart: node not found: ${path}`);

  const handler = coreResolve(node.$type, 'service');
  if (!handler) throw new Error(`autostart: no service handler for ${node.$type}`);

  handles.set(path, await handler(node, _svcCtx));
  console.log(`[autostart] started ${path}`);
}

async function _stopService(path: string): Promise<void> {
  const h = handles.get(path);
  if (!h) return;
  await h.stop();
  handles.delete(path);
  console.log(`[autostart] stopped ${path}`);
}

// ── Public API — direct import for server code, typed actions for MCP/tRPC ──

export async function startService(path: string): Promise<void> {
  if (!_svcCtx) throw new Error('autostart: not initialized');
  if (handles.has(path)) return;

  // Add ref child → tree reflects reality
  const name = path.split('/').filter(Boolean).join('-');
  const refPath = `${_autostartPath}/${name}`;
  const existing = await _svcCtx.store.get(refPath);
  if (!existing) {
    await _svcCtx.store.set({ $path: refPath, $type: 'ref', $ref: path } as NodeData);
  }

  await _startService(path);
}

export async function stopService(path: string): Promise<void> {
  if (!_svcCtx) throw new Error('autostart: not initialized');

  await _stopService(path);

  // Remove ref child → tree reflects reality
  const { items } = await _svcCtx.store.getChildren(_autostartPath);
  const ref = items.find(n => isRef(n) && n.$ref === path);
  if (ref) await _svcCtx.store.remove(ref.$path);
}

/** Service lifecycle manager — start/stop services via ref children */
export class Autostart {
  /** @description Start a service at given path */
  async start(data: { /** service to start */ path: string }) { await startService(data.path); }
  /** @description Stop a service at given path */
  async stop(data: { path: string }) { await stopService(data.path); }
}
registerType('autostart', Autostart);

// ── Boot service handler ──

register('autostart', 'service', async (node, ctx) => {
  _svcCtx = ctx;
  _autostartPath = node.$path;

  const { items } = await ctx.store.getChildren(node.$path);
  for (const child of items) {
    try {
      const target = await resolveRef(ctx.store, child);
      await _startService(target.$path);
    } catch (e) {
      console.error(`[autostart] failed ${child.$path}:`, e);
    }
  }

  return {
    stop: async () => {
      for (const path of [...handles.keys()]) {
        await _stopService(path).catch(console.error);
      }
    },
  };
});
