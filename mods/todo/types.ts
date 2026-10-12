import { registerType } from '@treenx/core/comp';

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

registerType('todo.item', TodoItem);
// Native child creation has no client-side prediction.
registerType('todo.list', TodoList, { noOptimistic: ['add'] });
export { TodoItem, TodoList };

interface TodoList {
  /** @description Add a new todo item */
  add(data: { title: string }): Promise<void>;
}
