import { randomUUID } from 'node:crypto';
import { getComponent, isRef } from '@treenx/core';
import { KernelError } from '@treenx/core/errors';
import { A, R, W, type ActionDef, type Node, type NodeInput, type Reader, type ReadActionContext, type WriteActionContext } from '@treenx/core/kernel/types';
import type { NativeBranchConflict, NativeBranchDelta, NativeBranchDiff, NativeBranchState, NativeBranchWrapper } from './native-types';
import { nativeBranchPaths } from '#branch/native-index';

function at(root: string, suffix: string): string { return `${root === '/' ? '' : root}${suffix}` || '/'; }
function state(node: Node): NativeBranchState {
  const value = getComponent<NativeBranchState>(node, 't.branch');
  if (value === undefined) throw new KernelError('INVALID', 'Branch action has another owning type');
  return value;
}
async function read(reader: Reader, path: string): Promise<Node | null> {
  try {
    const copy = (await reader.read({ node: path })).copies[0];
    if ('error' in copy) {
      if (copy.error.code === 'NOT_FOUND') return null;
      throw copy.error;
    }
    return copy.node;
  } catch (error) {
    if (error instanceof KernelError && error.code === 'NOT_FOUND') return null;
    throw error;
  }
}
function input(args: unknown): Record<string, unknown> {
  if (args === undefined) return {};
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new KernelError('INVALID', 'Expected branch arguments');
  return { ...args };
}
function text(args: Record<string, unknown>, field: string): string | undefined {
  const value = args[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new KernelError('INVALID', 'Expected branch text argument');
  return value;
}

function rewriteRefs(node: NodeInput, view: string, base: string, path: string): NodeInput {
  const clone: NodeInput = structuredClone(node);
  function walk(value: unknown): void {
    if (isRef(value)) {
      if (value.$ref === view || value.$ref.startsWith(`${view}/`)) value.$ref = at(base, value.$ref.slice(view.length));
    } else if (Array.isArray(value)) {
      for (const member of value) walk(member);
    } else if (value !== null && typeof value === 'object') {
      for (const [key, member] of Object.entries(value)) if (!key.startsWith('$') || key === '$refs') walk(member);
    }
  }
  walk(clone);
  return { ...clone, $path: path };
}

async function diff(ctx: ReadActionContext): Promise<NativeBranchDiff[]> {
  const config = state(ctx.node), root = `${ctx.node.$path}/delta`, entries: NativeBranchDiff[] = [];
  function append(stored: Node, type: 't.branch.delta' | 't.branch.whiteout'): void {
    const path = at(config.base, stored.$path.slice(root.length));
    const wrapper = getComponent<NativeBranchWrapper>(stored, type);
    if (wrapper === undefined) throw new KernelError('CONFLICT', 'Branch future has another type');
    if (type === 't.branch.whiteout') {
      entries.push({ path, op: wrapper.baseRev === null ? 'noop' : 'remove', baseRev: wrapper.baseRev });
      return;
    }
    const delta = getComponent<NativeBranchDelta>(stored, type);
    if (delta === undefined) throw new KernelError('CONFLICT', 'Branch delta has another type');
    const future: NodeInput = { ...delta.node,
      ...(stored.$acl === undefined ? {} : { $acl: stored.$acl }),
      ...(stored.$owner === undefined ? {} : { $owner: stored.$owner }) };
    entries.push({ path, op: wrapper.baseRev === null ? 'create' : 'set', baseRev: wrapper.baseRev,
      node: rewriteRefs(future, `${ctx.node.$path}/tree`, config.base, path) });
  }
  const container = await read(ctx.read, root);
  if (container === null) throw new KernelError('NOT_FOUND', 'Branch has no upper container');
  const rootDelta = getComponent(container, 't.branch.delta'), rootWhiteout = getComponent(container, 't.branch.whiteout');
  if (rootDelta !== undefined && rootWhiteout !== undefined)
    throw new KernelError('CONFLICT', 'Branch root has competing future components');
  for (const suffix of await nativeBranchPaths(container, ctx.read)) {
    const stored = suffix === '' ? container : await read(ctx.read, at(root, suffix));
    if (stored === null) {
      if (config.status === 'merged' || config.status === 'abandoned') continue;
      throw new KernelError('CONFLICT', 'Branch index lost its future wrapper');
    }
    const delta = getComponent(stored, 't.branch.delta');
    const whiteout = getComponent(stored, 't.branch.whiteout');
    if (delta === undefined && whiteout === undefined || delta !== undefined && whiteout !== undefined)
      throw new KernelError('CONFLICT', 'Branch index requires one future wrapper');
    append(stored, delta === undefined ? 't.branch.whiteout' : 't.branch.delta');
  }
  return entries;
}

export function branchContainerActions(): Readonly<Record<string, ActionDef>> {
  return { create: { kind: 'write', args: { properties: {
    title: { type: 'string' }, owner: { type: 'string' }, ownerPath: { type: 'string' }, base: { type: 'string' },
  } }, async handler(ctx, args) {
    const data = input(args), caller = ctx.caller.principal;
    let owner = text(data, 'owner') ?? (caller.startsWith('u:') ? caller.slice(2) : caller.startsWith('n:') ? caller : undefined);
    const ownerPath = text(data, 'ownerPath');
    if (ownerPath !== undefined) {
      const executor = (await ctx.read.read({ node: ownerPath })).copies[0];
      if ('error' in executor) throw executor.error;
      const principal = `n:${executor.node.$id}`;
      if (text(data, 'owner') !== undefined && owner !== principal)
        throw new KernelError('INVALID', 'Branch owner differs from its executor');
      owner = principal;
    } else if (owner?.startsWith('n:')) {
      throw new KernelError('INVALID', 'Node-owned branch requires its executor path');
    }
    if (owner === undefined || owner.length === 0) throw new KernelError('INVALID', 'Branch requires an owning account');
    const path = `${ctx.node.$path}/b-${randomUUID()}`;
    ctx.change.put({ $path: path, $type: 't.branch', base: text(data, 'base') ?? '/', owner, status: 'open',
      title: text(data, 'title') ?? '', createdAt: Date.now(), mergedAt: 0, conflicts: [],
      '#mount': { $type: 't.mount.branch', pattern: 'tree' },
      $acl: [{ subject: { group: 'admins' }, grant: R | W | A }, { subject: { group: owner.startsWith('n:') ? owner : `u:${owner}` }, grant: R | W | A }] });
    ctx.change.put({ $path: `${path}/delta`, $type: 't.dir', '#changes': { $type: 't.branch.index', paths: [] } });
    ctx.change.put({ $path: `${path}/tree`, $type: 't.dir' });
    return { path };
  } } };
}

/** Keeps lifecycle transitions in the caller's frame when model reads already depend on the branch. */
export async function stageNativeBranchControl(ctx: WriteActionContext, path: string,
  action: 'requestMerge' | 'abandon', args: unknown) {
  await ctx.requireReadWrite(path);
  const copy = (await ctx.read.read({ node: path })).copies[0];
  if ('error' in copy) throw copy.error;
  const config = state(copy.node);
  if (action === 'abandon') {
    if (config.status === 'merged') throw new KernelError('CONFLICT', 'Merged branch cannot be abandoned');
    ctx.change.patch(path, { $set: { status: 'abandoned' } });
    return { status: 'abandoned' };
  }
  const note = text(input(args), 'note');
  if (config.status !== 'open') throw new KernelError('CONFLICT', 'Branch is not open for review');
  const title = note ? (config.title ? `${config.title} — ${note}` : note) : config.title;
  ctx.change.patch(path, { $set: { status: 'review', title } });
  return { status: 'review' };
}

export function branchActions(): Readonly<Record<string, ActionDef>> {
  return {
    diff: { kind: 'read', args: {}, async handler(ctx) { return { entries: await diff(ctx) }; } },
    abandon: { kind: 'write', args: {}, async handler(ctx) {
      return stageNativeBranchControl(ctx, ctx.node.$path, 'abandon', {});
    } },
    requestMerge: { kind: 'write', args: { properties: { note: { type: 'string' } } }, async handler(ctx, args) {
      return stageNativeBranchControl(ctx, ctx.node.$path, 'requestMerge', args);
    } },
    merge: { kind: 'write', args: {}, async handler(ctx) {
      const config = state(ctx.node);
      if (config.status !== 'open' && config.status !== 'review') throw new KernelError('CONFLICT', 'Branch is not mergeable');
      const entries = await diff(ctx), conflicts: NativeBranchConflict[] = [];
      for (const entry of entries) {
        if (entry.op !== 'noop') await ctx.requireReadWrite(entry.path);
        const current = await read(ctx.read, entry.path);
        const actualRev = current?.$rev ?? null;
        if (actualRev !== entry.baseRev) conflicts.push({ path: entry.path, expectedRev: entry.baseRev, actualRev });
      }
      if (conflicts.length > 0) {
        ctx.change.patch(ctx.node.$path, { $set: { status: 'conflict', conflicts } });
        return { merged: 0, applied: [], conflicts };
      }
      const applied: string[] = [];
      for (const entry of entries) {
        if (entry.op === 'noop') continue;
        if (entry.op === 'remove') ctx.change.remove(entry.path);
        else {
          const suffix = entry.path === config.base ? '' : entry.path.slice(config.base === '/' ? 0 : config.base.length);
          const source = at(`${ctx.node.$path}/tree`, suffix);
          ctx.change.adopt(source, entry.path);
        }
        applied.push(entry.path);
      }
      ctx.change.patch(ctx.node.$path, { $set: { status: 'merged', mergedAt: Date.now(), conflicts: [] } });
      return { merged: applied.length, applied, conflicts: [], status: 'merged' };
    } },
  };
}
