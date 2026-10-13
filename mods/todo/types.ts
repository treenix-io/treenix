import { declareClientType } from '@treenx/core/comp/client-declaration';
import { declareOpenModule } from '@treenx/core/kernel/module-declaration';


/** Single checklist item with a title and completion flag. */
class TodoItem {
  title = '';
  done = false;

  /** @description Toggle done state */
  toggle() {
    this.done = !this.done;
  }
}

/** Container that creates todo.item children from add action calls. */
class TodoList {
  title = 'My Todos';
}

const declaredTodoItem = declareClientType('todo.item', TodoItem);
// Native child creation has no client-side prediction.
const declaredTodoList = declareClientType('todo.list', TodoList, { noOptimistic: ['add'] });
export { TodoItem, TodoList };

interface TodoList {
  /** @description Add a new todo item */
  add(data: { title: string }): Promise<void>;
}

export const clientModules = [declareOpenModule('@treenx/mods/todo/types', [], [
  declaredTodoItem,
  declaredTodoList,
])];
