// Treenity Patch — Layer 1
// Compact [op, path, value?] tuples with dot-notation paths.
// Maps 1:1 to RFC 6902 JSON Patch.

import type { NodeData } from '#core';

// ── Types ──

export type PatchOp =
  | readonly ['t', string, unknown]     // test
  | readonly ['r', string, unknown]     // replace
  | readonly ['a', string, unknown]     // add (field or array push via path.-)
  | readonly ['d', string]              // delete

export type Rfc6902Op =
  | { op: 'test'; path: string; value: unknown }
  | { op: 'replace'; path: string; value: unknown }
  | { op: 'add'; path: string; value: unknown }
  | { op: 'remove'; path: string }

export class PatchTestError extends Error {
  code = 'TEST_FAILED' as const;
  constructor(public field: string, public expected: unknown, public actual: unknown) {
    super(`Patch test failed: ${field}`);
  }
}

// ── Apply ops to object in-place ──

export function applyOps(target: Record<string, unknown>, ops: readonly PatchOp[]): void {
  for (const op of ops) {
    switch (op[0]) {
      case 't': {
        const actual = getByPath(target, op[1]);
        if (actual !== op[2]) throw new PatchTestError(op[1], op[2], actual);
        break;
      }
      case 'r':
        setByPath(target, op[1], op[2]);
        break;
      case 'a':
        if (op[1].endsWith('.-')) {
          const arrPath = op[1].slice(0, -2);
          const arr = getByPath(target, arrPath);
          if (!Array.isArray(arr)) throw new Error(`add: ${arrPath} is not an array`);
          arr.push(op[2]);
        } else {
          setByPath(target, op[1], op[2]);
        }
        break;
      case 'd':
        deleteByPath(target, op[1]);
        break;
    }
  }
}

// ── Path helpers (dot notation) ──

function getByPath(obj: any, path: string): unknown {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function setByPath(obj: any, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function deleteByPath(obj: any, path: string): void {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null) return;
    cur = cur[parts[i]];
  }
  delete cur[parts[parts.length - 1]];
}

// ── RFC 6902 conversion ──

function dotToSlash(p: string): string { return '/' + p.replace(/\./g, '/'); }
function slashToDot(p: string): string { return p.slice(1).replace(/\//g, '.'); }

export function toRfc6902(ops: readonly PatchOp[]): Rfc6902Op[] {
  return ops.map(op => {
    const path = dotToSlash(op[1]);
    switch (op[0]) {
      case 't': return { op: 'test', path, value: op[2] };
      case 'r': return { op: 'replace', path, value: op[2] };
      case 'a': return { op: 'add', path, value: op[2] };
      case 'd': return { op: 'remove', path };
    }
  });
}

export function fromRfc6902(ops: readonly Rfc6902Op[]): PatchOp[] {
  return ops.map(op => {
    const path = slashToDot(op.path);
    switch (op.op) {
      case 'test': return ['t', path, op.value] as const;
      case 'replace': return ['r', path, op.value] as const;
      case 'add': return ['a', path, op.value] as const;
      case 'remove': return ['d', path] as const;
    }
  });
}

// ── Default patch: get → apply → set (fallback for adapters without native patch) ──

export async function defaultPatch(
  get: (path: string, ctx?: unknown) => Promise<NodeData | undefined>,
  set: (node: NodeData, ctx?: unknown) => Promise<void>,
  path: string,
  ops: readonly PatchOp[],
  ctx?: unknown,
): Promise<void> {
  const node = await get(path, ctx);
  if (!node) throw new Error(`Node not found: ${path}`);
  const copy = JSON.parse(JSON.stringify(node));
  applyOps(copy, ops);
  await set(copy, ctx);
}
