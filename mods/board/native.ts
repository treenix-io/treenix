import { register } from '@treenx/core'
import { registerType } from '@treenx/core/comp'
import { registerKernelAction, type ActionDef } from '@treenx/core/kernel'
import type { TypeSchema } from '@treenx/core/schema/types'
import { BoardTask, BoardKanban, BoardColumn, Order } from './types'
import task from './schemas/board.task.json'
import kanban from './schemas/board.kanban.json'
import column from './schemas/board.column.json'
import order from './schemas/board.order.json'

/** Compose Plan's tree-building actions with Board's existing atomic class workflow. */
export function registerNativeBoard(plan: { readonly addSubtask: ActionDef; readonly schedule: ActionDef }): void {
  // The owner must capture classes and methods even when another module imported their data types first.
  registerType('board.task', BoardTask)
  registerType('board.kanban', BoardKanban)
  registerType('board.column', BoardColumn)
  registerType('board.order', Order)

  for (const [name, schema] of Object.entries({ 'board.task': task, 'board.kanban': kanban, 'board.column': column, 'board.order': order })) {
    const definition: TypeSchema = { ...schema, type: 'object' }
    register(name, 'schema', () => definition)
  }

  registerKernelAction('board.task', 'add-subtask', plan.addSubtask)
  registerKernelAction('board.task', 'schedule', plan.schedule)
}
