import { getComponent } from '@treenx/core';
import { KernelError } from '@treenx/core/errors';
import type { ChangeMember, ModuleManifest, MountHandler, Node, Reader, StoreBinding, StoreBindingBody, StoreBindingProjection } from '@treenx/core/kernel/types';

import { branchActions, branchContainerActions } from './native-actions';
import type { NativeBranchDelta, NativeBranchWrapper } from './native-types';
import branchSchema from './schemas/t.branch.json' with { type: 'json' };
import branchesSchema from './schemas/t.branches.json' with { type: 'json' };

const DELTA = 't.branch.delta', WHITEOUT = 't.branch.whiteout', ROOT_FUTURE = '#future';

interface NativeBranchConfig { readonly base: string }

function parent(path: string): string { return path.slice(0, path.lastIndexOf('/')) || '/'; }
function at(root: string, suffix: string): string { return `${root === '/' ? '' : root}${suffix}` || '/'; }
function relative(path: string, root: string): string {
  if (path === root) return '';
  if (!path.startsWith(root === '/' ? '/' : `${root}/`))
    throw new KernelError('INVALID', 'Branch path leaves its declared namespace');
  return path.slice(root === '/' ? 0 : root.length);
}

function body(node: Node): StoreBindingBody {
  const { $id, $rev, $acl, $owner, ...fields } = node;
  return fields;
}

function wrapper(node: Node): NativeBranchWrapper | null {
  if (node.$type === 't.dir') {
    const delta = getComponent<NativeBranchDelta>(node, DELTA);
    const whiteout = getComponent<NativeBranchWrapper>(node, WHITEOUT);
    if (delta !== undefined && whiteout !== undefined)
      throw new KernelError('CONFLICT', 'Branch root has competing future components');
    return delta ?? whiteout ?? null;
  }
  const value = getComponent<NativeBranchWrapper>(node, node.$type);
  if ((node.$type !== DELTA && node.$type !== WHITEOUT) || value === undefined)
    throw new KernelError('CONFLICT', 'Branch upper contains a foreign wrapper');
  return value;
}

async function nodeAt(reader: Reader, path: string): Promise<Node | null> {
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

/** Restores provenance from an accepted physical upper wrapper without inventing a lower read. */
function describeUpper(stored: Node): StoreBindingProjection | null {
  const state = wrapper(stored);
  if (state === null) return null;
  const source = state.baseId === null ? 'upper' : 'lower';
  if (getComponent(stored, WHITEOUT) !== undefined) return { node: null, source, baseId: state.baseId };
  const delta = getComponent<NativeBranchDelta>(stored, DELTA);
  if (delta === undefined) throw new KernelError('CONFLICT', 'Branch delta has another type');
  return { node: delta.node, source, baseId: state.baseId };
}

/** Bodies stay module-owned; physical authorization, logical identity and the commit stay kernel-owned. */
export function createNativeBranchBinding(view: string, lower: string, upper: string): StoreBinding {
  const branches = parent(parent(view));
  function denied(path: string): boolean { return path === branches || path.startsWith(`${branches}/`); }
  return {
    path: view, lower, upper, describe: describeUpper,
    select(live, stored) {
      const suffix = stored === null ? (live === null ? '' : relative(live.$path, lower)) : relative(stored.$path, upper);
      if (denied(at(lower, suffix))) return null;
      if (stored !== null && stored.$path === upper && wrapper(stored) === null) stored = null;
      if (stored === null)
        return live === null ? null : { node: body(live), source: 'lower', baseId: live.$id };
      return describeUpper(stored);
    },
    async changes(transitions, reader) {
      const changes: ChangeMember[] = [];
      for (const transition of transitions) {
        const suffix = relative(transition.path, view), path = at(upper, suffix), lowerPath = at(lower, suffix);
        if (denied(lowerPath)) throw new KernelError('FORBIDDEN', 'Branch cannot expose its control namespace as future data');
        const existing = await nodeAt(reader, path), live = await nodeAt(reader, lowerPath);
        if (transition.before !== null && transition.before.$path !== transition.path && transition.after !== null) {
          const originalSuffix = relative(transition.before.$path, view);
          const originalPath = at(upper, originalSuffix), originalLowerPath = at(lower, originalSuffix);
          if (denied(originalLowerPath)) throw new KernelError('FORBIDDEN', 'Branch cannot move its control namespace as future data');
          const original = await nodeAt(reader, originalPath), originalLower = await nodeAt(reader, originalLowerPath);
          if (originalPath === upper || path === upper) throw new KernelError('INVALID', 'Branch root cannot be moved');
          const provenance = (original === null ? null : wrapper(original))
            ?? { baseId: originalLower?.$id ?? null, baseRev: originalLower?.$rev ?? null };
          const state = { baseId: provenance.baseId, baseRev: provenance.baseRev };
          if (existing !== null) changes.push({ op: 'remove', path });
          if (original !== null) {
            if (original.$type !== DELTA) throw new KernelError('CONFLICT', 'Branch move source is not a live delta');
            changes.push({ op: 'move', from: originalPath, to: path });
            changes.push({ op: 'patch', path, ops: { $set: { node: transition.after } } });
          } else changes.push({ op: 'put', node: { $path: path, $type: DELTA, ...state, node: transition.after } });
          changes.push({ op: 'put', node: { $path: originalPath, $type: WHITEOUT, ...state } });
          continue;
        }
        const acceptedWrapper = existing === null ? null : wrapper(existing);
        const provenance = acceptedWrapper ?? { baseId: live?.$id ?? null, baseRev: live?.$rev ?? null };
        const state = { baseId: provenance.baseId, baseRev: provenance.baseRev };
        if (path === upper) {
          const future = transition.after === null
            ? { $type: WHITEOUT, ...state }
            : { $type: DELTA, ...state,
              ...(existing !== null && getComponent(existing, WHITEOUT) !== undefined ? { baseId: null } : {}),
              node: transition.after };
          changes.push({ op: 'patch', path, ops: { $set: { [ROOT_FUTURE]: future } } });
          continue;
        }
        if (transition.after === null) {
          if (existing !== null && existing.$type !== WHITEOUT) changes.push({ op: 'remove', path });
          changes.push({ op: 'put', node: { $path: path, $type: WHITEOUT, ...state } });
        } else {
          if (existing?.$type === WHITEOUT) changes.push({ op: 'remove', path });
          changes.push({ op: 'put', node: { $path: path, $type: DELTA, ...state,
            ...(existing?.$type === WHITEOUT ? { baseId: null } : {}), node: transition.after } });
        }
      }
      return changes;
    },
  };
}

/** The declaring branch owns its base; its relative mount covers only the future tree. */
export const nativeBranchMount: MountHandler = async declaration => {
  const config = getComponent<NativeBranchConfig>(declaration, 't.branch');
  if (config === undefined) throw new KernelError('INVALID', 'Branch mount must belong to its owning branch');
  return { kind: 'store', binding: createNativeBranchBinding(`${declaration.$path}/tree`, config.base, `${declaration.$path}/delta`),
    async close() {} };
};


export function nativeBranchManifest(): ModuleManifest {
  const metadata = { baseId: { anyOf: [{ type: 'string' }, { type: 'null' }] }, baseRev: { anyOf: [{ type: 'string' }, { type: 'null' }] } };
  return { id: '@treenx/mods/branch', open: [], types: [
    { name: 't.branches', module: '@treenx/mods/branch', security: 'ordinary', version: 0,
      schema: branchesSchema, actions: branchContainerActions() },
    { name: 't.branch', module: '@treenx/mods/branch', security: 'ordinary', version: 0, actions: branchActions(),
      schema: { ...branchSchema, properties: { ...branchSchema.properties, conflicts: { type: 'array', items: {
        type: 'object', properties: { path: { type: 'string' }, expectedRev: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          actualRev: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, required: ['path', 'expectedRev', 'actualRev'] } } } } },
    { name: DELTA, module: '@treenx/mods/branch', security: 'ordinary', version: 0, actions: {},
      schema: { type: 'object', properties: { ...metadata, node: { type: 'object', required: ['$path', '$type'],
        not: { anyOf: [{ required: ['$acl'] }, { required: ['$owner'] }, { required: ['$id'] }, { required: ['$rev'] }] } } },
        required: ['baseId', 'baseRev', 'node'] } },
    { name: WHITEOUT, module: '@treenx/mods/branch', security: 'ordinary', version: 0, actions: {},
      schema: { type: 'object', properties: metadata, required: ['baseId', 'baseRev'] } },
    { name: 't.mount.branch', module: '@treenx/mods/branch', security: 'user-capability', version: 0, actions: {},
      schema: { type: 'object', properties: {} } },
  ], security: [{ type: 't.mount.branch', context: 'mount', handler: nativeBranchMount }] };
}
