import crypto from 'node:crypto';
import { createNode, register } from '@treenx/core';
import { KernelError } from '@treenx/core/errors';
import {
  registerKernelAction,
  type ReadResult,
  type WriteActionContext,
} from '@treenx/core/kernel';
import type { TypeSchema } from '@treenx/core/schema/types';
import itemSchema from './schemas/todo.item.json';
import listSchema from './schemas/todo.list.json';
import type { TodoItem } from './types';

const item: TypeSchema = { ...itemSchema, type: 'object' };
const list: TypeSchema = { ...listSchema, type: 'object' };
const { name: _argumentName, ...argument } = listSchema.methods.add.arguments[0];

/** Collect the existing schemas and native writing actions without importing legacy handlers. */
export function registerNativeTodo(): void {
  register('todo.item', 'schema', () => item);
  register('todo.list', 'schema', () => list);
  registerKernelAction('todo.list', 'add', {
    kind: 'write',
    args: { ...argument, type: 'object' },
    handler: nativeAdd,
  });
  registerKernelAction('todo.item', 'toggle', {
    kind: 'write',
    args: {},
    handler: nativeToggle,
  });
}

/** Create one authorized, incomplete child; an occupied address never replaces an accepted item. */
export async function nativeAdd(ctx: WriteActionContext, args: unknown): Promise<void> {
  if (
    typeof args !== 'object' ||
    args === null ||
    !('title' in args) ||
    typeof args.title !== 'string'
  )
    throw new KernelError('INVALID', 'Title required');
  const title = args.title.trim();
  if (title.length === 0) throw new KernelError('INVALID', 'Title required');

  const path = `${ctx.node.$path}/${Date.now().toString(36)}-${crypto.randomUUID()}`;
  await ctx.requireReadWrite(path);
  let existing: ReadResult;
  try {
    existing = await ctx.read.read({ node: path });
  } catch (error) {
    if (!(error instanceof KernelError) || error.code !== 'NOT_FOUND') throw error;
    const created = createNode(path, 'todo.item', { title, done: false });
    ctx.change.put({
      $path: created.$path,
      $type: created.$type,
      title: created.title,
      done: created.done,
    });
    return;
  }

  const copy = existing.copies[0];
  if ('error' in copy) throw copy.error;
  throw new KernelError('CONFLICT', 'Todo item address is occupied');
}

/** Flip the actual writing draft while preserving the item's remaining data. */
export async function nativeToggle(this: TodoItem): Promise<void> {
  this.done = !this.done;
}
