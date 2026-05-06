import { getCtx, registerType } from '@treenx/core/comp';

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

  /** @description Add a new todo item */
  async add(data: { title: string }) {
    if (!data.title?.trim()) throw new Error('Title required');
    const { node, tree } = getCtx();
    const id = Date.now().toString(36);
    await tree.set({
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
