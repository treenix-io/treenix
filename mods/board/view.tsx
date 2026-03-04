// Board views — kanban board + task detail (editable)

import { type NodeData, register } from '@treenity/core/core';
import { Render } from '@treenity/react/context';
import { set, useChildren, usePath } from '@treenity/react/hooks';
import { cn } from '@treenity/react/lib/utils';
import { trpc } from '@treenity/react/trpc';
import { Button } from '@treenity/react/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@treenity/react/ui/dialog';
import { Input } from '@treenity/react/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@treenity/react/ui/select';
import { Textarea } from '@treenity/react/ui/textarea';
import { useRef, useState } from 'react';
import { BoardColumn, BoardTask } from './types';

type TaskStatus = BoardTask['status'];

const PRIORITY_COLOR: Record<string, string> = {
  urgent: 'bg-red-500',
  high: 'bg-orange-400',
  normal: 'bg-blue-400',
  low: 'bg-zinc-400',
};

const PRIORITIES: { value: string; label: string }[] = [
  { value: 'urgent', label: 'Urgent' },
  { value: 'high', label: 'High' },
  { value: 'normal', label: 'Normal' },
  { value: 'low', label: 'Low' },
];

function PriorityDot({ priority }: { priority: string }) {
  return (
    <span
      className={cn('inline-block h-2 w-2 rounded-full', PRIORITY_COLOR[priority] ?? PRIORITY_COLOR.normal)}
      title={priority}
    />
  );
}

function AiBadge() {
  return (
    <span className="rounded bg-violet-500/20 px-1.5 py-0.5 text-[10px] font-medium text-violet-400">
      AI
    </span>
  );
}

// ── board.task view — editable task detail ──

function TaskView({ value }: { value: NodeData }) {
  const node = usePath(value.$path) as NodeData | undefined;
  const proxy = usePath(value.$path, BoardTask);
  const [editingDesc, setEditingDesc] = useState(false);
  if (!node || !proxy) return null;

  const title = typeof proxy.title === 'string' ? proxy.title : '';
  const description = typeof proxy.description === 'string' ? proxy.description : '';
  const status = (typeof proxy.status === 'string' ? proxy.status : 'backlog') as TaskStatus;
  const priority = typeof proxy.priority === 'string' ? proxy.priority : 'normal';
  const assignee = typeof proxy.assignee === 'string' ? proxy.assignee : '';
  const result = typeof proxy.result === 'string' ? proxy.result : '';

  const save = (patch: Record<string, unknown>) => {
    set({ ...node, ...patch, updatedAt: Date.now() });
  };

  return (
    <div className="space-y-4">
      <BlurInput
        value={title}
        placeholder="Task title..."
        className="border-none bg-transparent p-0 text-lg font-semibold shadow-none focus-visible:ring-0"
        onSave={v => save({ title: v })}
      />

      {editingDesc ? (
        <Textarea
          key={`desc-${value.$path}`}
          defaultValue={description}
          placeholder="Add a description..."
          className="max-h-60 min-h-20 resize-none text-sm"
          autoFocus
          onBlur={e => {
            if (e.target.value !== description) save({ description: e.target.value });
            setEditingDesc(false);
          }}
        />
      ) : description ? (
        <div
          className="cursor-pointer whitespace-pre-wrap rounded border border-transparent p-2 text-sm line-clamp-4 hover:border-border"
          onClick={() => setEditingDesc(true)}
          title="Click to edit"
        >
          {description}
        </div>
      ) : (
        <div
          className="cursor-pointer rounded border border-dashed border-border p-2 text-sm text-muted-foreground hover:border-foreground/30"
          onClick={() => setEditingDesc(true)}
        >
          Add a description...
        </div>
      )}

      <div className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
        <span className="text-muted-foreground">Status</span>
        <div className="flex items-center gap-2">
          <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium capitalize">{status}</span>
          <TaskActions proxy={proxy} status={status} />
        </div>

        <span className="text-muted-foreground">Priority</span>
        <Select value={priority} onValueChange={v => save({ priority: v })}>
          <SelectTrigger className="h-8 w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PRIORITIES.map(p => (
              <SelectItem key={p.value} value={p.value}>
                <span className="flex items-center gap-1.5">
                  <PriorityDot priority={p.value} /> {p.label}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <span className="text-muted-foreground">Assignee</span>
        <BlurInput
          value={assignee}
          placeholder="Unassigned"
          className="h-8 text-sm"
          onSave={v => save({ assignee: v })}
        />

        {(status === 'review' || status === 'done' || result) && (
          <>
            <span className="text-muted-foreground">Result</span>
            <Textarea
              key={`res-${value.$path}`}
              defaultValue={result}
              placeholder="Result notes..."
              className="min-h-12 resize-none text-sm"
              onBlur={e => {
                if (e.target.value !== result) save({ result: e.target.value });
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}

register('board.task', 'react', TaskView as any);

// ── Helpers ──

function TaskActions({ proxy, status }: { proxy: ReturnType<typeof usePath<BoardTask>>; status: TaskStatus }) {
  const btn = 'h-7 text-xs';
  switch (status) {
    case 'backlog':
      return <Button variant="outline" size="sm" className={btn} onClick={() => proxy.start()}>Start</Button>;
    case 'todo':
      return <Button variant="outline" size="sm" className={btn} onClick={() => proxy.start()}>Begin</Button>;
    case 'doing':
      return <Button variant="outline" size="sm" className={btn} onClick={() => proxy.submit()}>Submit</Button>;
    case 'review':
      return (
        <div className="flex gap-1">
          <Button variant="outline" size="sm" className={btn} onClick={() => proxy.approve()}>Approve</Button>
          <Button variant="ghost" size="sm" className={btn} onClick={() => proxy.reject()}>Reject</Button>
        </div>
      );
    case 'done':
      return <Button variant="ghost" size="sm" className={btn} onClick={() => proxy.reopen()}>Reopen</Button>;
    default:
      return null;
  }
}

function BlurInput({ value, onSave, ...props }: {
  value: string; onSave: (v: string) => void;
} & Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange' | 'onBlur' | 'onKeyDown'>) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <Input
      ref={ref}
      defaultValue={value}
      onBlur={e => { if (e.target.value !== value) onSave(e.target.value); }}
      onKeyDown={e => { if (e.key === 'Enter') ref.current?.blur(); }}
      {...props}
    />
  );
}

// ── Task card (kanban) ──

function TaskCard({ task, onSelect }: { task: NodeData; onSelect: (path: string) => void }) {
  const proxy = usePath(task.$path, BoardTask);

  const title = typeof proxy?.title === 'string' && proxy.title
    ? proxy.title
    : task.$path.split('/').at(-1);
  const assignee = typeof proxy?.assignee === 'string' ? proxy.assignee : '';
  const priority = typeof proxy?.priority === 'string' ? proxy.priority : 'normal';
  const result = typeof proxy?.result === 'string' ? proxy.result : '';
  const isAi = assignee === 'metatron';

  return (
    <div
      className="mb-2 cursor-pointer rounded-md border border-border bg-card p-3 shadow-sm transition-colors hover:bg-accent/50"
      onClick={() => onSelect(task.$path)}
    >
      <div className="mb-1 flex items-center gap-2">
        <PriorityDot priority={priority} />
        <span className="flex-1 text-sm font-semibold leading-tight">{title}</span>
        {isAi && <AiBadge />}
      </div>

      {assignee && !isAi && (
        <div className="mb-1 text-xs text-muted-foreground">{assignee}</div>
      )}

      {result && (
        <div className="line-clamp-2 text-xs text-muted-foreground">{result}</div>
      )}
    </div>
  );
}

// ── Column ──

function Column({ col, onSelect }: { col: NodeData; onSelect: (path: string) => void }) {
  const proxy = usePath(col.$path, BoardColumn);
  const tasks = useChildren(col.$path, { watch: true, watchNew: true });

  const label = typeof proxy?.label === 'string' ? proxy.label : col.$path.split('/').at(-1);
  const color = typeof proxy?.color === 'string' ? proxy.color : 'border-zinc-400';

  return (
    <div className="flex min-w-40 flex-1 flex-col">
      <div className={cn('mb-2 flex items-center gap-2 border-b-2 pb-1.5', color)}>
        <span className="text-sm font-bold">{label}</span>
        <span className="text-xs text-muted-foreground">({tasks.length})</span>
      </div>

      <div className="flex-1">
        {tasks.map(task => (
          <TaskCard key={task.$path} task={task} onSelect={onSelect} />
        ))}

        {tasks.length === 0 && (
          <div className="rounded-md border border-dashed border-border py-6 text-center text-xs text-muted-foreground">
            Empty
          </div>
        )}
      </div>
    </div>
  );
}

// ── Kanban Board ──

function KanbanView({ value }: { value: NodeData }) {
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const selectedNode = usePath(selectedTask ?? '') as NodeData | undefined;
  const basePath = value.$path;

  const children = useChildren(basePath, { watch: true, watchNew: true });
  const columns = children
    .filter(c => c.$type === 'board.column')
    .sort((a, b) => ((a as any).order ?? 0) - ((b as any).order ?? 0));

  const createTask = async () => {
    const id = Date.now().toString(36).toUpperCase();
    await trpc.set.mutate({
      node: {
        $path: `${basePath}/data/${id}`,
        $type: 'board.task',
        title: `Task #${id}`,
        status: 'backlog',
        priority: 'normal',
        assignee: '',
        description: '',
        result: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as NodeData,
    });
  };

  return (
    <div className="view-full px-4 py-3">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-bold">Task Board</h2>
        <Button onClick={createTask}>+ New Task</Button>
      </div>

      <div className="flex gap-3 overflow-x-auto pb-2">
        {columns.map(col => (
          <Column key={col.$path} col={col} onSelect={setSelectedTask} />
        ))}
      </div>

      {selectedTask && selectedNode && (
        <Dialog open onOpenChange={open => { if (!open) setSelectedTask(null); }}>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg" aria-describedby={undefined}>
            <DialogTitle className="sr-only">Task</DialogTitle>
            <Render value={selectedNode} />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

register('board.kanban', 'react', KanbanView as any);
