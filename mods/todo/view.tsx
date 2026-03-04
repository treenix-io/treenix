import { type NodeData, register } from '@treenity/core/core';
import { useChildren, usePath } from '@treenity/react/hooks';
import { useState } from 'react';
import { TodoItem, TodoList } from './types';

function TodoListView({ value }: { value: NodeData }) {
  const list = usePath(value.$path, TodoList);
  const children = useChildren(value.$path, { watch: true, watchNew: true });
  const [draft, setDraft] = useState('');

  const handleAdd = async () => {
    if (!draft.trim()) return;
    await list.add({ title: draft });
    setDraft('');
  };

  return (
    <div className="max-w-md mx-auto p-4">
      <h2 className="text-xl font-bold mb-4">{list.title}</h2>

      <div className="flex gap-2 mb-4">
        <input
          className="flex-1 border rounded px-3 py-1.5 text-sm"
          placeholder="What needs to be done?"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleAdd()}
        />
        <button
          className="bg-blue-600 text-white px-3 py-1.5 rounded text-sm"
          onClick={handleAdd}
        >Add</button>
      </div>

      <ul className="space-y-1">
        {children.map(child => (
          <TodoItemRow key={child.$path} value={child} />
        ))}
      </ul>
    </div>
  );
}

function TodoItemRow({ value }: { value: NodeData }) {
  const item = usePath(value.$path, TodoItem);

  return (
    <li
      className="flex items-center gap-2 px-3 py-2 rounded
        hover:bg-neutral-100 cursor-pointer"
      onClick={() => item.toggle()}
    >
      <span className={`w-4 h-4 rounded border flex items-center
        justify-center text-xs ${item.done
          ? 'bg-blue-600 border-blue-600 text-white'
          : 'border-neutral-300'}`}>
        {item.done ? '✓' : ''}
      </span>
      <span className={item.done ? 'line-through text-neutral-400' : ''}>
        {item.title}
      </span>
    </li>
  );
}

register('todo.list', 'react', TodoListView as any);
register('todo.item', 'react', TodoItemRow as any);
