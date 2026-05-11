import { register } from '@treenx/core';
import { Render, useActions, useChildren, type View } from '@treenx/react';
import { Button } from '@treenx/react/ui/button';
import { Input } from '@treenx/react/ui/input';
import { useState } from 'react';
import { TodoItem, TodoList } from './types';

const TodoListView: View<TodoList> = ({ value, ctx }) => {
  const actions = useActions(value);
  const { data: children } = useChildren(ctx!.path, { watch: true, watchNew: true });
  const [draft, setDraft] = useState('');

  const handleAdd = async () => {
    if (!draft.trim()) return;
    await actions.add({ title: draft });
    setDraft('');
  };

  return (
    <div className="max-w-md mx-auto p-4">
      <h2 className="text-xl font-bold mb-4">{value.title}</h2>

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
          <Render key={child.$path} value={child} />
        ))}
      </ul>
    </div>
  );
};

const TodoItemRow: View<TodoItem> = ({ value }) => {
  const actions = useActions(value);

  return (
    <li
      className="flex items-center gap-2 px-3 py-2 rounded
        hover:bg-muted cursor-pointer"
      onClick={() => actions.toggle()}
    >
      <span className={`w-4 h-4 rounded border flex items-center
        justify-center text-xs ${value.done
          ? 'bg-primary border-primary text-primary-foreground'
          : 'border-input'}`}>
        {value.done ? '✓' : ''}
      </span>
      <span className={value.done ? 'line-through text-muted-foreground' : ''}>
        {value.title}
      </span>
    </li>
  );
};

register(TodoList, 'react', TodoListView);
register(TodoItem, 'react', TodoItemRow);
