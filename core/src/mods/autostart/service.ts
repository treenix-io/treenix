// Autostart — service coordinator with dynamic start/stop
// Walks children at boot, tracks handles, exposes start/stop actions
// Tree = truth: ref child exists ↔ service is running

import { getCtx, registerType } from '#comp';
import { OpError } from '#errors';
import { type ServiceCtx, type ServiceHandle } from '#contexts/service/index';
import { isRef, type NodeData, register, resolve as coreResolve } from '#core';
import { withActor } from '#server/actions';
import { resolveRef } from '#tree';

// ── Module-scope service tracking ──

const handles = new Map<string, ServiceHandle>();
let _svcCtx: ServiceCtx | null = null;
let _autostartPath = '/sys/autostart';

async function _startService(path: string): Promise<void> {
  if (handles.has(path)) return;
  if (!_svcCtx) throw new Error('autostart: not initialized');

  const node = await _svcCtx.tree.get(path);
  if (!node) throw new Error(`autostart: node not found: ${path}`);

  const handler = coreResolve(node.$type, 'service');
  if (!handler) throw new Error(`autostart: no service handler for ${node.$type}`);

  // Per-service actor (core-anz4.14): every write the service issues through
  // its ctx.tree attributes as service:<path> in audit — never anonymous. The
  // wrap refines the supervisor-level system:autostart bind from the factory.
  const tree = withActor(_svcCtx.tree, { id: `service:${path}` });
  handles.set(path, await handler(node, { ..._svcCtx, tree, path }));
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

  // Start first; a failed start must not leave a ref claiming the service runs.
  await _startService(path);

  // Started → add ref child so tree reflects reality
  const name = path.split('/').filter(Boolean).join('-');
  const refPath = `${_autostartPath}/${name}`;
  const existing = await _svcCtx.tree.get(refPath);
  if (!existing) {
    await _svcCtx.tree.set({ $path: refPath, $type: 'ref', $ref: path } as NodeData);
  }
}

export async function stopService(path: string): Promise<void> {
  if (!_svcCtx) throw new Error('autostart: not initialized');

  await _stopService(path);

  // Remove ref child → tree reflects reality
  const { items } = await _svcCtx.tree.getChildren(_autostartPath);
  const ref = items.find(n => isRef(n) && n.$ref === path);
  if (ref) await _svcCtx.tree.remove(ref.$path);
}

/** Service lifecycle manager — start/stop services via ref children.
 *  A service runs on the supervisor's system tree while actions need only R
 *  here, so both actions first change the ref registry through the CALLER's
 *  tree: a principal without W on the registry is refused before anything
 *  starts or stops (an anonymous caller used to start system services). */
export class Autostart {
  /** @description Start a service at given path */
  async start(data: { /** service to start */ path: string }) {
    const caller = getCtx().tree;
    const refPath = `${_autostartPath}/${data.path.split('/').filter(Boolean).join('-')}`;
    const existed = !!(await caller.get(refPath));
    await caller.set({ $path: refPath, $type: 'ref', $ref: data.path } as NodeData);
    try {
      await _startService(data.path);
    } catch (e) {
      // A failed start must not leave a ref claiming the service runs.
      if (!existed) await caller.remove(refPath);
      throw e;
    }
  }

  /** @description Stop a service at given path */
  async stop(data: { path: string }) {
    const caller = getCtx().tree;
    const { items } = await caller.getChildren(_autostartPath);
    const ref = items.find(n => isRef(n) && n.$ref === data.path);
    if (!ref) throw new OpError('NOT_FOUND', `autostart: ${data.path} is not registered`);
    await caller.remove(ref.$path);
    await _stopService(data.path);
  }
}
registerType('autostart', Autostart);

// ── Boot service handler ──

register('autostart', 'service', async (node, ctx) => {
  _svcCtx = ctx;
  _autostartPath = node.$path;

  const { items } = await ctx.tree.getChildren(node.$path);
  for (const child of items) {
    try {
      const target = await resolveRef(ctx.tree, child);
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
