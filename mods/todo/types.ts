import { getCtx, registerType } from '@treenity/core/comp';

class TodoItem {
  title = '';
  done = false;

  /** @description Toggle done state */
  toggle() {
    this.done = !this.done;
  }
}

class TodoList {
  title = 'My Todos';

  /** @description Add a new todo item */
  async add(data: { title: string }) {
    if (!data.title?.trim()) throw new Error('Title required');
    const { node, store } = getCtx();
    const id = Date.now().toString(36);
    await store.set({
      $path: `${node.$path}/${id}`,
      $type: 'todo.item',
      title: data.title.trim(),
      done: false,
    });
  }
}

registerType('todo.item', TodoItem);
registerType('todo.list', TodoList);
export { TodoItem, TodoList };
