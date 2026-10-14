import { type ActionDef } from '@treenx/core/kernel';
import { nativeDeclaredModule, type NativeClassDeclaration } from '#native-module';
import type { ModuleManifest } from '@treenx/core/kernel/types';
import type { TypeSchema } from '@treenx/core/schema/types';
import { BoardTask, BoardKanban, BoardColumn, Order } from './types';
import task from './schemas/board.task.json';
import kanban from './schemas/board.kanban.json';
import column from './schemas/board.column.json';
import order from './schemas/board.order.json';

/** Compose Plan's tree-building actions with Board's existing atomic class workflow. */
export function nativeBoardManifest(
  id: string,
  plan: { readonly addSubtask: ActionDef; readonly schedule: ActionDef },
): ModuleManifest {
  const schemas: Record<string, TypeSchema> = {};
  for (const [name, schema] of Object.entries({
    'board.task': task,
    'board.kanban': kanban,
    'board.column': column,
    'board.order': order,
  })) {
    const definition: TypeSchema = { ...schema, type: 'object' };
    schemas[name] = definition;
  }
  const classes: Record<string, NativeClassDeclaration> = {
    'board.task': { cls: BoardTask, security: 'ordinary' },
    'board.kanban': { cls: BoardKanban, security: 'ordinary' },
    'board.column': { cls: BoardColumn, security: 'ordinary' },
    'board.order': { cls: Order, security: 'ordinary' },
  };
  return nativeDeclaredModule(
    id,
    schemas,
    { 'board.task': { 'add-subtask': plan.addSubtask, schedule: plan.schedule } },
    classes,
    [],
  );
}
