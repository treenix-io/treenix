// Launcher widgets — react:widget context for compact live views on the home screen

import { type NodeData, register } from '@treenity/core/core';
import type { RenderProps } from '@treenity/react/context';
import { useChildren, usePath } from '@treenity/react/hooks';
import { cn } from '@treenity/react/lib/utils';
import type { FC } from 'react';
import { TodoItem } from '../todo/types';

const KanbanWidget: FC<RenderProps> = ({ value }) => {
  const node = value as NodeData;
  return <KanbanWidgetInner path={node.$path} />;
};

// Separate component to use hooks properly per column
function KanbanWidgetInner({ path }: { path: string }) {
  const columns = useChildren(path, { watch: true, watchNew: true })
    .filter(c => c.$type === 'board.column')
    .sort((a, b) => ((a as any).order ?? 0) - ((b as any).order ?? 0));

  return (
    <div className="flex h-full flex-col justify-between gap-1">
      {columns.map(col => (
        <ColumnRow key={col.$path} col={col} />
      ))}
    </div>
  );
}

function ColumnRow({ col }: { col: NodeData }) {
  const tasks = useChildren(col.$path, { watch: true, watchNew: true });
  const label = typeof col.label === 'string' ? col.label : col.$path.split('/').at(-1) || '?';
  const color = typeof col.color === 'string' ? col.color : 'border-zinc-400';
  // Extract bg color from border color class
  const dotColor = color.replace('border-', 'bg-');

  return (
    <div className="flex items-center gap-2">
      <span className={cn('h-2 w-2 shrink-0 rounded-full', dotColor)} />
      <span className="flex-1 truncate text-[11px] text-white/70">{label}</span>
      <span className="text-xs font-semibold text-white/90">{tasks.length}</span>
    </div>
  );
}

register('board.kanban', 'react:widget', KanbanWidget as any);

// ── todo.list widget — compact checklist ──

const TodoWidget: FC<RenderProps> = ({ value }) => {
  const node = value as NodeData;
  // value might be the todo dir — find the list child
  const children = useChildren(node.$path, { watch: true, watchNew: true });
  const list = children.find(c => c.$type === 'todo.list');

  if (list) return <TodoListItems path={list.$path} />;

  // value IS the list
  return <TodoListItems path={node.$path} />;
};

function TodoListItems({ path }: { path: string }) {
  const items = useChildren(path, { watch: true, watchNew: true });
  const doneCount = items.filter(i => i.done).length;

  return (
    <div className="flex h-full flex-col">
      <div className="mb-1 text-[10px] text-white/50">
        {doneCount}/{items.length} done
      </div>

      <div className="flex flex-1 flex-col gap-0.5 overflow-hidden">
        {items.slice(0, 5).map(item => (
          <TodoItemCompact key={item.$path} value={item} />
        ))}
        {items.length > 5 && (
          <span className="text-[10px] text-white/40">+{items.length - 5} more</span>
        )}
      </div>
    </div>
  );
}

function TodoItemCompact({ value }: { value: NodeData }) {
  const item = usePath(value.$path, TodoItem);

  return (
    <div className="flex items-center gap-1.5">
      <span className={cn(
        'flex h-3 w-3 shrink-0 items-center justify-center rounded-sm border text-[8px]',
        item.done
          ? 'border-green-400/50 bg-green-500/30 text-green-300'
          : 'border-white/20',
      )}>
        {item.done ? '✓' : ''}
      </span>
      <span className={cn(
        'truncate text-[11px]',
        item.done ? 'text-white/30 line-through' : 'text-white/80',
      )}>
        {item.title}
      </span>
    </div>
  );
}

register('todo.list', 'react:widget', TodoWidget as any);

// ── examples.demo.sensor widget — last value + mini bars ──

const SensorWidget: FC<RenderProps> = ({ value }) => {
  const node = value as NodeData;
  const children = useChildren(node.$path, { watch: true, watchNew: true });
  const last5 = children.slice(-5);
  const latest = last5[last5.length - 1];

  const latestVal = typeof latest?.value === 'number' ? latest.value : null;
  const latestTs = typeof latest?.ts === 'number' ? new Date(latest.ts).toLocaleTimeString() : '--:--';

  return (
    <div className="flex h-full items-center gap-3">
      {/* Big number */}
      <div className="flex flex-col">
        <span className="text-2xl font-bold tabular-nums text-white/90">
          {latestVal !== null ? `${latestVal}°` : '—'}
        </span>
        <span className="text-[9px] text-white/40">{latestTs}</span>
      </div>

      {/* Mini bars */}
      <div className="flex flex-1 items-end gap-0.5 self-end pb-1">
        {last5.map((n, i) => {
          const val = typeof n.value === 'number' ? n.value : 20;
          const h = Math.max(4, Math.round(((val - 15) / 15) * 32));
          return (
            <div
              key={n.$path}
              className={cn(
                'flex-1 rounded-sm',
                i === last5.length - 1 ? 'bg-emerald-400' : 'bg-emerald-400/40',
              )}
              style={{ height: h }}
            />
          );
        })}
        {last5.length === 0 && (
          <span className="text-[10px] text-white/30">No data</span>
        )}
      </div>
    </div>
  );
};

register('examples.demo.sensor', 'react:widget', SensorWidget as any);

// ── Default widget fallback — type + icon ──

const DefaultWidget: FC<RenderProps> = ({ value }) => {
  const node = value as NodeData;
  const typeParts = node.$type.split('.');
  const name = typeParts[typeParts.length - 1] || node.$type;

  return (
    <div className="flex h-full flex-col items-center justify-center text-white/50">
      <span className="text-lg font-bold capitalize">{name}</span>
      <span className="text-[10px]">{node.$path}</span>
    </div>
  );
};

register('default', 'react:widget', DefaultWidget as any);
