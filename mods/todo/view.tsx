import { type NodeData, register } from '@treenx/core';
import { useChildren, usePath } from '@treenx/react';
import { Button } from '@treenx/react/ui/button';
import { Input } from '@treenx/react/ui/input';
import { useState } from 'react';
import { TodoItem, TodoList } from './types';

function TodoListView({ value }: { value: NodeData }) {
  const { data: list } = usePath(value.$path, TodoList);
  const { data: children } = useChildren(value.$path, { watch: true, watchNew: true });
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
        <Input
          className="flex-1"
          placeholder="What needs to be done?"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleAdd()}
        />
        <Button size="sm" onClick={handleAdd}>Add</Button>
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
  const { data: item } = usePath(value.$path, TodoItem);

  return (
    <li
      className="flex items-center gap-2 px-3 py-2 rounded
        hover:bg-muted cursor-pointer"
      onClick={() => item.toggle()}
    >
      <span className={`w-4 h-4 rounded border flex items-center
        justify-center text-xs ${item.done
          ? 'bg-primary border-primary text-primary-foreground'
          : 'border-input'}`}>
        {item.done ? '✓' : ''}
      </span>
      <span className={item.done ? 'line-through text-muted-foreground' : ''}>
        {item.title}
      </span>
    </li>
  );
}

register('todo.list', 'react', TodoListView as any);
register('todo.item', 'react', TodoItemRow as any);
