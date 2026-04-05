// Board views — kanban board + task detail (editable)

import {
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  pointerWithin,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { type ComponentData, type NodeData, register } from '@treenity/core';
import type { PatchOp } from '@treenity/core/tree';
import { Render, RenderContext, useActions, type View } from '@treenity/react';
import { execute, set, useChildren, useNavigate, usePath } from '@treenity/react';
import { transliterate } from '@treenity/react/lib/string-utils';
import { minimd } from '@treenity/react';
import { cn } from '@treenity/react';
import { trpc } from '@treenity/react';
import { Button } from '@treenity/react/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@treenity/react/ui/dialog';
import { FormField } from '@treenity/react/ui/form-field';
import { Input } from '@treenity/react/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@treenity/react/ui/select';
import { Textarea } from '@treenity/react/ui/textarea';
import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AttachMenu } from '../simple-components/view';
import { BoardColumn, BoardKanban, BoardTask } from './types';

type TaskStatus = string;

async function withToast(fn: () => Promise<unknown>, successMsg?: string) {
  try {
    await fn();
    if (successMsg) toast.success(successMsg);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Operation failed');
  }
}

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

const TaskView: View<BoardTask> = ({ value, ctx }) => {
  const node = ctx?.node;
  const actions = useActions(value);
  const [editingDesc, setEditingDesc] = useState(false);
  if (!node || !value) return null;

  const title = typeof value.title === 'string' ? value.title : '';
  const description = typeof value.description === 'string' ? value.description : '';
  const status = (typeof value.status === 'string' ? value.status : 'backlog') as TaskStatus;
  const priority = typeof value.priority === 'string' ? value.priority : 'normal';
  const assignee = typeof value.assignee === 'string' ? value.assignee : '';
  const result = typeof value.result === 'string' ? value.result : '';

  const save = (patch: Record<string, unknown>) => {
    const ops: PatchOp[] = Object.entries({ ...patch, updatedAt: Date.now() })
      .map(([k, v]) => ['r', k, v] as const);
    withToast(() => trpc.patch.mutate({ path: node.$path, ops }));
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
          key={`desc-${node.$path}`}
          defaultValue={description}
          placeholder="Add a description..."
          className="max-h-60 min-h-20 resize-none text-sm"
          autoFocus
          onBlur={e => {
            if (e.target.value !== description) save({ description: e.target.value });
            setEditingDesc(false);
          }}
        />
      ) : (
        <div
          tabIndex={0}
          role="button"
          className={cn(
            'cursor-pointer rounded border p-2 text-sm',
            description
              ? 'whitespace-pre-wrap border-transparent hover:border-border'
              : 'border-dashed border-border text-muted-foreground hover:border-foreground/30',
          )}
          onClick={() => setEditingDesc(true)}
          onFocus={() => setEditingDesc(true)}
          title="Click to edit"
        >
          {description || 'Add a description...'}
        </div>
      )}

      <div className="space-y-2 text-sm">
        <FormField label="Status">
          <div className="flex items-center gap-2">
            <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium capitalize">{status}</span>
            <TaskActions actions={actions} status={status} />
          </div>
        </FormField>

        <FormField label="Priority">
          <Select value={priority} onValueChange={v => save({ priority: v })}>
            <SelectTrigger className="h-8 w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" portal={false} className="min-w-32">
              {PRIORITIES.map(p => (
                <SelectItem key={p.value} value={p.value}>
                  <span className="flex items-center gap-1.5">
                    <PriorityDot priority={p.value} /> {p.label}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>

        <FormField label="Assignee">
          <BlurInput
            value={assignee}
            placeholder="Unassigned"
            className="h-8 text-sm"
            onSave={v => save({ assignee: v })}
          />
        </FormField>

        {(status === 'review' || status === 'done' || result) && (
          <FormField label="Result">
            <ResultField path={node.$path} result={result} onSave={v => save({ result: v })} />
          </FormField>
        )}
      </div>

      {/* Named components (ai.plan, ai.thread, etc.) */}
      <NamedComponents node={node} />

      <AttachMenu node={node} />

      <EmbeddedTaskLog taskRef={typeof node.taskRef === 'string' ? node.taskRef : ''} />

    </div>
  );
};

function NamedComponents({ node }: { node: NodeData }) {
  const keys = Object.keys(node).filter(k => {
    if (k.startsWith('$') || k === 'taskRef') return false;
    const v = node[k];
    return v && typeof v === 'object' && '$type' in v;
  });
  if (!keys.length) return null;

  return (
    <div className="flex flex-col gap-3">
      {keys.map(k => (
        <Render key={k} value={node[k] as ComponentData} />
      ))}
    </div>
  );
}

function ResultField({ path, result, onSave }: { path: string; result: string; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const html = useMemo(() => result ? minimd(result) : '', [result]);

  if (editing) {
    return (
      <Textarea
        key={`res-${path}`}
        defaultValue={result}
        placeholder="Result notes..."
        className="min-h-20 max-h-60 resize-none text-sm"
        autoFocus
        onBlur={e => {
          if (e.target.value !== result) onSave(e.target.value);
          setEditing(false);
        }}
      />
    );
  }

  if (!result) {
    return (
      <div
        className="cursor-pointer rounded border border-dashed border-border p-2 text-sm text-muted-foreground hover:border-foreground/30"
        onClick={() => setEditing(true)}
      >
        Add result...
      </div>
    );
  }

  return (
    <div
      className="minimd cursor-pointer rounded border border-transparent p-2 text-sm max-h-60 overflow-y-auto hover:border-border"
      onClick={() => setEditing(true)}
      title="Click to edit"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function EmbeddedTaskLog({ taskRef }: { taskRef: string }) {
  const mtTask = usePath(taskRef || null) as NodeData | undefined;
  if (!mtTask) return null;

  return (
    <div className="mt-2 rounded-md border border-border p-2">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[10px] font-medium uppercase text-muted-foreground">Agent Log</span>
        <span className={cn(
          'rounded px-1.5 py-0.5 text-[10px] font-medium',
          mtTask.status === 'running' ? 'bg-sky-500/20 text-sky-400' :
          mtTask.status === 'done' ? 'bg-emerald-500/20 text-emerald-400' :
          'bg-red-500/20 text-red-400',
        )}>
          {String(mtTask.status)}
        </span>
      </div>
      <Render value={mtTask} />
    </div>
  );
}

register('board.task', 'react', TaskView);

const TaskListItem: View<BoardTask> = ({ value, ctx }) => {
  const nav = useNavigate();
  const node = ctx?.node;
  const path = node?.$path ?? '';
  const priority = value.priority || 'normal';
  const title = value.title || path.split('/').at(-1);
  const aiStatus = node && typeof node.aiStatus === 'string' ? node.aiStatus : '';
  const assignee = value.assignee || '';

  return (
    <button
      onClick={() => nav(path)}
      className="flex w-full items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-left transition-colors hover:bg-accent/50"
    >
      <PriorityDot priority={priority} />
      <span className="flex-1 truncate text-sm font-medium">{title}</span>
      {aiStatus && (
        <span className="rounded bg-violet-500/20 px-1.5 py-0.5 text-[10px] font-medium text-violet-400">
          {aiStatus}
        </span>
      )}
      {assignee && !aiStatus && (
        <span className="text-xs text-muted-foreground">{assignee}</span>
      )}
    </button>
  );
};

register('board.task', 'react:list', TaskListItem);

// ── Helpers ──

function TaskActions({ actions, status }: { actions: ReturnType<typeof useActions<BoardTask>>; status: TaskStatus }) {
  const btn = 'h-7 text-xs';
  switch (status) {
    case 'doing':
      return <Button tabIndex={-1} variant="outline" size="sm" className={btn} onClick={() => withToast(() => actions.submit())}>Submit</Button>;
    case 'review':
      return (
        <div className="flex gap-1">
          <Button tabIndex={-1} variant="outline" size="sm" className={btn} onClick={() => withToast(() => actions.approve())}>Approve</Button>
          <Button tabIndex={-1} variant="ghost" size="sm" className={btn} onClick={() => withToast(() => actions.reject())}>Reject</Button>
        </div>
      );
    case 'done':
      return <Button tabIndex={-1} variant="ghost" size="sm" className={btn} onClick={() => withToast(() => actions.reopen())}>Reopen</Button>;
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

function TaskCardContent({ task, isDragging }: { task: NodeData; isDragging?: boolean }) {
  const proxy = usePath(task.$path, BoardTask);

  const title = typeof proxy?.title === 'string' && proxy.title
    ? proxy.title
    : task.$path.split('/').at(-1);
  const description = typeof proxy?.description === 'string' ? proxy.description : '';
  const assignee = typeof proxy?.assignee === 'string' ? proxy.assignee : '';
  const priority = typeof proxy?.priority === 'string' ? proxy.priority : 'normal';
  const result = typeof proxy?.result === 'string' ? proxy.result : '';
  const aiStatus = typeof task.aiStatus === 'string' ? task.aiStatus : '';
  const isAi = assignee === 'metatron' || !!aiStatus;

  return (
    <div className={cn(
      'mb-1.5 rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2 transition-all',
      isDragging ? 'opacity-50 rotate-1 scale-105' : 'hover:bg-white/[0.06] hover:border-white/10',
    )}>
      <div className="flex items-center gap-2">
        <PriorityDot priority={priority} />
        <span className="flex-1 text-sm font-medium leading-snug truncate">{title}</span>
        {aiStatus ? (
          <span className="shrink-0 rounded bg-violet-500/20 px-1.5 py-0.5 text-[10px] font-medium text-violet-400">
            {String(aiStatus)}
          </span>
        ) : isAi ? <AiBadge /> : null}
      </div>

      {description && (
        <div className="mt-0.5 line-clamp-2 text-[11px] leading-tight text-muted-foreground pl-4">{description}</div>
      )}

      {assignee && (
        <div className="mt-1 flex items-center gap-1.5 pl-4 text-[11px] text-sky-400/70">
          <span className="inline-block h-3.5 w-3.5 rounded-full bg-sky-400/15 text-center text-[9px] font-bold leading-3.5 text-sky-400">{assignee.charAt(0).toUpperCase()}</span>
          {assignee}
        </div>
      )}
    </div>
  );
}

function TaskCard({ task, onSelect, colStatus }: { task: NodeData; onSelect: (path: string) => void; colStatus: string }) {
  const proxy = usePath(task.$path, BoardTask);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.$path,
    data: { task, status: colStatus },
  });

  // dnd-kit requires inline style for runtime-computed transforms
  const style = { transform: CSS.Transform.toString(transform), transition };

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className="cursor-grab active:cursor-grabbing"
      style={style}
      onClick={() => { if (!isDragging) onSelect(task.$path); }}
    >
      <TaskCardContent task={task} isDragging={isDragging} />
    </div>
  );
}

// ── Column ──

function Column({ col, onSelect, onAddTask, highlighted }: { col: NodeData; onSelect: (path: string) => void; onAddTask: (status: string) => void; highlighted?: boolean }) {
  const proxy = usePath(col.$path, BoardColumn);
  const tasks = useChildren(col.$path, { watch: true, watchNew: true });
  const status = col.$path.split('/').at(-1) ?? '';
  const { setNodeRef } = useDroppable({ id: `col:${status}`, data: { status } });

  const label = typeof proxy?.label === 'string' ? proxy.label : status;
  const color = typeof proxy?.color === 'string' ? proxy.color : 'border-zinc-400';
  const taskIds = useMemo(() => tasks.map(t => t.$path), [tasks]);

  return (
    <div className="group flex w-[240px] shrink-0 flex-col">
      <div className={cn('mb-2 flex items-center gap-2 border-b-2 pb-1.5', color)}>
        <BlurInput
          value={label}
          className="h-auto border-none bg-transparent p-0 text-sm font-bold shadow-none focus-visible:ring-0"
          onSave={v => withToast(() => set({ ...col, label: v, updatedAt: Date.now() }))}
        />
        <span className="text-xs text-muted-foreground">({tasks.length})</span>
        <button
          onClick={async () => {
            if (!confirm(`Delete column "${label}"?`)) return;
            await withToast(() => trpc.remove.mutate({ path: col.$path }), 'Column deleted');
          }}
          className="ml-auto hidden text-xs text-muted-foreground group-hover:block hover:text-destructive"
          title="Delete column"
        >
          ✕
        </button>
      </div>

      <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          className={cn(
            'flex-1 rounded-md p-1 transition-colors min-h-32',
            highlighted && 'bg-accent/30 ring-1 ring-accent',
          )}
        >
          {tasks.map(task => (
            <TaskCard key={task.$path} task={task} onSelect={onSelect} colStatus={status} />
          ))}

          <button
            onClick={() => onAddTask(status)}
            className={cn(
              'w-full rounded-md border border-dashed border-border py-2 text-center text-xs text-muted-foreground hover:border-foreground/30 hover:text-foreground',
              tasks.length === 0 && 'py-6',
            )}
          >
            {highlighted ? 'Drop here' : '+ Add task'}
          </button>
        </div>
      </SortableContext>
    </div>
  );
}

// ── Kanban Board ──

const KanbanView: View<BoardKanban> = ({ value, ctx }) => {
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [activeTask, setActiveTask] = useState<NodeData | null>(null);
  const [overColumn, setOverColumn] = useState<string | null>(null);
  const selectedNode = usePath(selectedTask ?? '') as NodeData | undefined;
  const basePath = ctx!.path;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const children = useChildren(basePath, { watch: true, watchNew: true });
  const columns = children
    .filter(c => c.$type === 'board.column')
    .sort((a, b) => {
      const oa = typeof a.order === 'number' ? a.order : 0;
      const ob = typeof b.order === 'number' ? b.order : 0;
      return oa - ob;
    });

  const createTask = async (status: string) => {
    await withToast(async () => {
      await trpc.set.mutate({ node: { $path: `${basePath}/data`, $type: 'dir' } as NodeData });
      const id = Date.now().toString(36).toUpperCase();
      const taskPath = `${basePath}/data/${id}`;
      await trpc.set.mutate({
        node: {
          $path: taskPath,
          $type: 'board.task',
          title: '',
          status,
          priority: 'normal',
          assignee: '',
          description: '',
          result: '',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        } as NodeData,
      });
      setSelectedTask(taskPath);
    });
  };

  const createColumn = async () => {
    const label = window.prompt('Column name:');
    if (!label?.trim()) return;
    const slug = transliterate(label).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const maxOrder = Math.max(0, ...columns.map(c => typeof c.order === 'number' ? c.order : 0));

    await withToast(async () => {
      await trpc.set.mutate({
        node: {
          $path: `${basePath}/${slug}`,
          $type: 'board.column',
          label: label.trim(),
          color: 'border-zinc-400',
          order: maxOrder + 1,
          mount: { $type: 't.mount.query', source: `${basePath}/data`, match: { status: slug } },
        } as NodeData,
      });
    }, `Column "${label.trim()}" created`);
  };

  const handleDragStart = (event: DragStartEvent) => {
    const task = event.active.data.current?.task;
    if (task && typeof task === 'object' && '$path' in task) {
      setActiveTask(task as NodeData);
    }
  };

  const handleDragOver = (event: DragOverEvent) => {
    const over = event.over;
    if (!over) { setOverColumn(null); return; }

    // Over a column droppable
    const overId = String(over.id);
    if (overId.startsWith('col:')) { setOverColumn(overId.slice(4)); return; }

    // Over a card — get its column status
    const status = over.data.current?.status;
    setOverColumn(typeof status === 'string' ? status : null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveTask(null);
    setOverColumn(null);
    const { active, over } = event;
    if (!over) return;

    // Target is either a column droppable (col:status) or a card sortable (has data.status)
    const overId = String(over.id);
    const targetStatus = over.data.current?.status
      ?? (overId.startsWith('col:') ? overId.slice(4) : undefined);
    if (typeof targetStatus !== 'string') return;

    const src = active.data.current;
    if (!src?.task || typeof src.task !== 'object' || !('status' in src.task)) return;
    if (src.task.status === targetStatus) return;

    const taskPath = (src.task as NodeData).$path;
    withToast(() => execute(taskPath, 'move', { status: targetStatus }, 'board.task'));
  };

  return (
    <div className="view-full px-4 py-3">
      <div className="mb-3">
        <h2 className="text-lg font-bold">Task Board</h2>
      </div>

      <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragStart={handleDragStart} onDragOver={handleDragOver} onDragEnd={handleDragEnd}>
        <div className="flex gap-3 overflow-x-auto pb-2">
          {columns.map(col => (
            <Column key={col.$path} col={col} onSelect={setSelectedTask} onAddTask={createTask} highlighted={overColumn === (col.$path.split('/').at(-1) ?? '')} />
          ))}
          <button
            onClick={createColumn}
            className="flex min-w-32 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground hover:border-foreground/30 hover:text-foreground"
          >
            + Column
          </button>
        </div>

        <DragOverlay dropAnimation={null}>
          {activeTask && (
            <div className="w-60 rotate-2 opacity-90">
              <TaskCardContent task={activeTask} />
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {selectedTask && selectedNode && (
        <Dialog open modal={false} onOpenChange={open => { if (!open) setSelectedTask(null); }}>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[960px]" aria-describedby={undefined}>
            <DialogTitle className="sr-only">Task</DialogTitle>
            <Render value={selectedNode} />
            <div className="flex justify-between pt-2 border-t border-border">
              <Button
                variant="ghost"
                size="sm"
                className="text-xs text-destructive hover:text-destructive"
                onClick={async () => {
                  const hasEdits = selectedNode.title || selectedNode.description;
                  if (hasEdits && !confirm('Delete this task?')) return;
                  await withToast(() => trpc.remove.mutate({ path: selectedTask }), 'Task deleted');
                  setSelectedTask(null);
                }}
              >
                Delete
              </Button>
              <Button onClick={() => setSelectedTask(null)}>Done</Button>
            </div>
          </DialogContent>
        </Dialog>
      )}

    </div>
  );
};

register('board.kanban', 'react', KanbanView);

// ── board.column view ──

const ColumnView: View<BoardColumn> = ({ value, ctx }) => {
  const path = ctx?.node?.$path ?? '';
  const tasks = useChildren(path, { watch: true, watchNew: true });
  const label = value.label || path.split('/').at(-1);
  const color = value.color || 'border-zinc-400';

  return (
    <div className="flex flex-col gap-2 p-3">
      <div className={cn('flex items-center gap-2 border-b-2 pb-1.5', color)}>
        <span className="text-sm font-bold">{label}</span>
        <span className="text-xs text-muted-foreground">({tasks.length})</span>
      </div>
      <RenderContext name="react:list">
        {tasks.map(task => (
          <Render key={task.$path} value={task} />
        ))}
        {tasks.length === 0 && (
          <div className="rounded-md border border-dashed border-border py-4 text-center text-xs text-muted-foreground">
            Empty
          </div>
        )}
      </RenderContext>
    </div>
  );
};

register('board.column', 'react', ColumnView);
