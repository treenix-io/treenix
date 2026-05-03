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
import { arrayMove, horizontalListSortingStrategy, SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { type NodeData, register } from '@treenx/core';
import { Render, RenderContext, useActions, useDraft, type View } from '@treenx/react';
import { createNode, execute, removeNode, useChildren, useNavigate, usePath } from '@treenx/react';
import { usePathSave } from '@treenx/react';
import { cleanSlug } from '@treenx/react/lib/string-utils';
import { minimd } from '@treenx/react';
import { cn } from '@treenx/react';
import { Button } from '@treenx/react/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@treenx/react/ui/dialog';
import { FormField } from '@treenx/react/ui/form-field';
import { Input } from '@treenx/react/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@treenx/react/ui/select';
import { Textarea } from '@treenx/react/ui/textarea';
import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AttachMenu } from '../simple-components/view';
import { getNamedComponents } from './named-components';
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
      className={cn(
        'block h-2 w-2 shrink-0 rounded-full',
        PRIORITY_COLOR[priority] ?? PRIORITY_COLOR.normal,
      )}
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

const TaskEdit: View<BoardTask, { draft?: boolean }> = ({ value, onChange, ctx, draft }) => {
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
  const runRef = typeof node.currentRun === 'string' ? node.currentRun : '';

  const save = (patch: Record<string, unknown>) => {
    onChange?.({ ...patch, updatedAt: Date.now() });
  };

  return (
    <div className="space-y-4">
      <BlurInput
        value={title}
        placeholder="Task title..."
        className="border-none bg-transparent p-0 text-lg font-semibold shadow-none focus-visible:ring-0"
        onSave={(v) => save({ title: v })}
      />

      {editingDesc ? (
        <Textarea
          key={`desc-${node.$path}`}
          defaultValue={description}
          placeholder="Add a description..."
          className="max-h-60 min-h-20 resize-none text-sm"
          autoFocus
          onBlur={(e) => {
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
            <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium capitalize">
              {status}
            </span>
            {!draft && <TaskActions actions={actions} status={status} />}
          </div>
        </FormField>

        <FormField label="Priority">
          <Select value={priority} onValueChange={(v) => save({ priority: v })}>
            <SelectTrigger className="h-8 w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" noPortal className="min-w-32">
              {PRIORITIES.map((p) => (
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
            onSave={(v) => save({ assignee: v })}
          />
        </FormField>

        {(status === 'review' || status === 'done' || result) && (
          <FormField label="Result">
            <ResultField path={node.$path} result={result} onSave={(v) => save({ result: v })} />
          </FormField>
        )}
      </div>

      {/* Named components (ai.plan, ai.thread, etc.) */}
      <NamedComponents node={node} />

      <AttachMenu node={node} />

      <EmbeddedTaskLog taskRef={runRef} />
    </div>
  );
};

register(BoardTask, 'react:edit', TaskEdit);

function NamedComponents({ node }: { node: NodeData }) {
  const entries = getNamedComponents(node);
  if (!entries.length) return null;

  return (
    <div className="flex flex-col gap-3">
      {entries.map(([key, value]) => (
        <Render key={key} value={value} />
      ))}
    </div>
  );
}

function ResultField({
  path,
  result,
  onSave,
}: {
  path: string;
  result: string;
  onSave: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const html = useMemo(() => (result ? minimd(result) : ''), [result]);

  if (editing) {
    return (
      <Textarea
        key={`res-${path}`}
        defaultValue={result}
        placeholder="Result notes..."
        className="min-h-20 max-h-60 resize-none text-sm"
        autoFocus
        onBlur={(e) => {
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
  const { data: mtTask } = usePath(taskRef || null);
  if (!mtTask || mtTask.$type === 'board.task') return null;

  return (
    <div className="mt-2 rounded-md border border-border p-2">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[10px] font-medium uppercase text-muted-foreground">Agent Log</span>
        <span
          className={cn(
            'rounded px-1.5 py-0.5 text-[10px] font-medium',
            mtTask.status === 'running'
              ? 'bg-sky-500/20 text-sky-400'
              : mtTask.status === 'done'
                ? 'bg-emerald-500/20 text-emerald-400'
                : 'bg-red-500/20 text-red-400',
          )}
        >
          {String(mtTask.status)}
        </span>
      </div>
      <Render value={mtTask} />
    </div>
  );
}

const TaskListItem: View<BoardTask> = ({ value, ctx }) => {
  const node = ctx?.node;
  const path = node?.$path ?? '';
  const priority = value.priority || 'normal';
  const title = value.title || path.split('/').at(-1);
  const aiStatus = node && typeof node.aiStatus === 'string' ? node.aiStatus : '';
  const assignee = value.assignee || '';
  const named = node ? getNamedComponents(node) : [];

  return (
    <div className="flex w-full flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <PriorityDot priority={priority} />
        <span className="flex-1 truncate text-sm font-medium">{title}</span>
        {aiStatus && (
          <span className="rounded bg-violet-500/20 px-1.5 py-0.5 text-[10px] font-medium text-violet-400">
            {aiStatus}
          </span>
        )}
        {assignee && !aiStatus && (
          <span className="inline-flex items-center gap-1 text-[11px] text-sky-400/80">
            <span className="inline-block h-4 w-4 rounded-full bg-sky-400/15 text-center text-[9px] font-bold leading-4 text-sky-400">
              {assignee.charAt(0).toUpperCase()}
            </span>
            <span className="max-w-20 truncate">{assignee}</span>
          </span>
        )}
      </div>
      {named.length > 0 && (
        <RenderContext name="react:compact">
          <div className="flex flex-col gap-1.5 pl-4" onClick={(e) => e.stopPropagation()}>
            {named.map(([key, comp]) => (
              <Render key={key} value={comp} />
            ))}
          </div>
        </RenderContext>
      )}
    </div>
  );
};

register(BoardTask, 'react:list', TaskListItem);
register(BoardTask, 'react:card', TaskListItem);

// ── board.task read-only view (default react context) ──

const TaskReadView: View<BoardTask> = ({ value, ctx }) => {
  const description = typeof value?.description === 'string' ? value.description : '';
  const result = typeof value?.result === 'string' ? value.result : '';
  const descHtml = useMemo(() => (description ? minimd(description) : ''), [description]);
  const resultHtml = useMemo(() => (result ? minimd(result) : ''), [result]);

  const node = ctx?.node;
  if (!node || !value) return null;

  const title = typeof value.title === 'string' ? value.title : '';
  const status = typeof value.status === 'string' ? value.status : 'backlog';
  const priority = typeof value.priority === 'string' ? value.priority : 'normal';
  const assignee = typeof value.assignee === 'string' ? value.assignee : '';
  const aiStatus = typeof node.aiStatus === 'string' ? node.aiStatus : '';
  const isAi = assignee === 'metatron' || !!aiStatus;

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <PriorityDot priority={priority} />
        <h3 className="flex-1 text-base font-semibold">{title || node.$path.split('/').at(-1)}</h3>
        {aiStatus ? (
          <span className="rounded bg-violet-500/20 px-1.5 py-0.5 text-[10px] font-medium text-violet-400">
            {aiStatus}
          </span>
        ) : isAi ? (
          <AiBadge />
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded bg-muted px-2 py-0.5 font-medium capitalize">{status}</span>
        <span className="flex items-center gap-1 text-muted-foreground">
          <PriorityDot priority={priority} />
          <span className="capitalize">{priority}</span>
        </span>
        {assignee && (
          <span className="flex items-center gap-1 text-sky-400/80">
            <span className="inline-block h-3.5 w-3.5 rounded-full bg-sky-400/15 text-center text-[9px] font-bold leading-3.5 text-sky-400">
              {assignee.charAt(0).toUpperCase()}
            </span>
            {assignee}
          </span>
        )}
      </div>

      {description && (
        <div
          className="minimd whitespace-pre-wrap text-sm text-foreground/90"
          dangerouslySetInnerHTML={{ __html: descHtml }}
        />
      )}

      {result && (
        <div className="border-t border-border pt-2">
          <div className="mb-1 text-[10px] font-medium uppercase text-muted-foreground">Result</div>
          <div
            className="minimd text-sm text-foreground/90"
            dangerouslySetInnerHTML={{ __html: resultHtml }}
          />
        </div>
      )}

      <RenderContext name="react:compact">
        <NamedComponents node={node} />
      </RenderContext>
    </div>
  );
};

register(BoardTask, 'react', TaskReadView);

// ── Helpers ──

function TaskActions({
  actions,
  status,
}: {
  actions: ReturnType<typeof useActions<BoardTask>>;
  status: TaskStatus;
}) {
  const btn = 'h-7 text-xs';
  switch (status) {
    case 'doing':
      return (
        <Button
          tabIndex={-1}
          variant="outline"
          size="sm"
          className={btn}
          onClick={() => withToast(() => actions.submit())}
        >
          Submit
        </Button>
      );
    case 'review':
      return (
        <div className="flex gap-1">
          <Button
            tabIndex={-1}
            variant="outline"
            size="sm"
            className={btn}
            onClick={() => withToast(() => actions.approve())}
          >
            Approve
          </Button>
          <Button
            tabIndex={-1}
            variant="ghost"
            size="sm"
            className={btn}
            onClick={() => withToast(() => actions.reject())}
          >
            Reject
          </Button>
        </div>
      );
    case 'done':
      return (
        <Button
          tabIndex={-1}
          variant="ghost"
          size="sm"
          className={btn}
          onClick={() => withToast(() => actions.reopen())}
        >
          Reopen
        </Button>
      );
    default:
      return null;
  }
}

function BlurInput({
  value,
  onSave,
  ...props
}: {
  value: string;
  onSave: (v: string) => void;
} & Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange' | 'onBlur' | 'onKeyDown'>) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <Input
      ref={ref}
      defaultValue={value}
      onBlur={(e) => {
        if (e.target.value !== value) onSave(e.target.value);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') ref.current?.blur();
      }}
      {...props}
    />
  );
}

// ── Task card (kanban) ──

function TaskCard({
  task,
  onSelect,
  colStatus,
}: {
  task: NodeData;
  onSelect: (path: string) => void;
  colStatus: string;
}) {
  const { data: proxy } = usePath(task.$path, BoardTask);
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
      className="cursor-grab active:cursor-grabbing rounded-md border border-border bg-card px-3 py-2 text-left transition-colors hover:bg-accent/50"
      style={style}
      onClick={() => {
        if (!isDragging) onSelect(task.$path);
      }}
    >
      <Render value={task} isDragging={isDragging} />
    </div>
  );
}

// ── Column ──

// ── KanbanColumn — View<BoardColumn>, self-contained ──

type ColumnExtra = {
  onSelect: (path: string) => void;
  onCreate: (status: string) => void;
  editable?: boolean;
  overStatus?: string | null;
};

const KanbanColumn: View<BoardColumn, ColumnExtra> = ({
  value,
  onChange,
  ctx,
  onSelect,
  onCreate,
  editable = false,
  overStatus,
}) => {
  const path = ctx!.node.$path;
  const { data: tasks } = useChildren(path, { watch: true, watchNew: true });
  const status = path.split('/').at(-1) ?? '';
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: `col:${status}`, data: { status } });
  const sortable = useSortable({
    id: path,
    data: { type: 'column', path },
    disabled: !editable,
  });
  const style = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
  };

  const label = value.label || status;
  const taskIds = useMemo(() => tasks.map((t) => t.$path), [tasks]);

  return (
    <div
      ref={sortable.setNodeRef}
      style={style}
      className={cn('group flex w-[240px] shrink-0 flex-col', sortable.isDragging && 'opacity-50')}
    >
      <div
        className={cn(
          'mb-2 flex items-center gap-2 border-b-2 pb-1.5',
          value.color || 'border-zinc-400',
        )}
      >
        {editable && (
          <button
            ref={sortable.setActivatorNodeRef}
            {...sortable.listeners}
            {...sortable.attributes}
            className="cursor-grab text-muted-foreground hover:text-foreground"
            title="Drag to reorder column"
          >
            ⋮⋮
          </button>
        )}
        {editable ? (
          <BlurInput
            value={label}
            className="h-auto border-none bg-transparent p-0 text-sm font-bold shadow-none focus-visible:ring-0"
            onSave={(v) => onChange?.({ label: v })}
          />
        ) : (
          <span className="text-sm font-bold">{label}</span>
        )}
        <span className="text-xs text-muted-foreground">({tasks.length})</span>
        {editable && (
          <button
            onClick={async () => {
              if (!confirm(`Delete column "${label}"?`)) return;
              await withToast(() => removeNode(path), 'Column deleted');
            }}
            className="ml-auto hidden text-xs text-muted-foreground group-hover:block hover:text-destructive"
            title="Delete column"
          >
            ✕
          </button>
        )}
      </div>

      <RenderContext name="react:card">
        <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
          <div
            ref={setDropRef}
            className={cn(
              'flex-1 rounded-md p-1 transition-colors min-h-32',
              (isOver || overStatus === status) && 'bg-accent/30 ring-1 ring-accent',
            )}
          >
            {tasks.map((task) => (
              <div key={task.$path} className='mb-2'>
                <TaskCard task={task} onSelect={onSelect} colStatus={status} />
              </div>
            ))}

            <button
              onClick={() => onCreate(status)}
              className={cn(
                'w-full rounded-md border border-dashed border-border py-2 text-center text-xs text-muted-foreground hover:border-foreground/30 hover:text-foreground',
                tasks.length === 0 && 'py-6',
              )}
            >
              {(isOver || overStatus === status) ? 'Drop here' : '+ Add task'}
            </button>
          </div>
        </SortableContext>
      </RenderContext>
    </div>
  );
};

const KanbanColumnEdit: View<BoardColumn, ColumnExtra> = (props) => <KanbanColumn {...props} editable />;
register('board.column', 'react:edit', KanbanColumnEdit);
register('board.column', 'react', KanbanColumn);

function TaskDialog({
  node,
  onChange,
  onClose,
  onSave,
}: {
  node: NodeData;
  onChange: (partial: Record<string, unknown>) => void;
  onClose: () => void;
  onSave?: () => void;
}) {
  return (
    <Dialog
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogTitle className="sr-only">Task</DialogTitle>
        <RenderContext name="react:edit">
          <Render value={node} onChange={onChange} draft={!!onSave} />
        </RenderContext>
        <div className="flex justify-end gap-2 pt-2 border-t border-border">
          {onSave ? (
            <>
              <Button variant="ghost" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button size="sm" onClick={onSave}>
                Create
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="destructive"
                size="sm"
                onClick={async () => {
                  const hasEdits = node.title || node.description;
                  if (hasEdits && !confirm('Delete this task?')) return;
                  await withToast(() => removeNode(node.$path), 'Task deleted');
                  onClose();
                }}
              >
                Delete
              </Button>
              <Button size="sm" onClick={onClose}>
                Done
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Kanban Board ──

const KanbanView: View<BoardKanban, { editable?: boolean }> = ({ value, ctx, editable = false }) => {
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const draft = useDraft('board.task');
  const [activeTask, setActiveTask] = useState<NodeData | null>(null);
  const [overStatus, setOverStatus] = useState<string | null>(null);
  const { data: selectedNode } = usePath(selectedTask || null);
  const basePath = ctx!.path;
  const saves = usePathSave();

  const handleCreate = (status: string) => {
    draft.create({
      title: '',
      status,
      priority: 'normal',
      assignee: '',
      description: '',
      result: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  };

  const handleDraftSave = async () => {
    if (!draft.node) return;
    const title = typeof draft.node.title === 'string' ? draft.node.title.trim() : '';
    const slug = cleanSlug(title);
    if (!slug) {
      toast.error('Title is required');
      return;
    }
    await withToast(() => draft.commit(`${basePath}/data/${slug}`));
  };

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const { data: children } = useChildren(basePath, { watch: true, watchNew: true });
  const columns = children
    .filter((c) => c.$type === 'board.column')
    .sort((a, b) => {
      const oa = typeof a.order === 'number' ? a.order : 0;
      const ob = typeof b.order === 'number' ? b.order : 0;
      return oa - ob;
    });

  const addColumn = async () => {
    const label = window.prompt('Column name:');
    if (!label?.trim()) return;
    const slug = cleanSlug(label);
    const maxOrder = Math.max(
      0,
      ...columns.map((c) => (typeof c.order === 'number' ? c.order : 0)),
    );

    await withToast(async () => {
      await createNode(`${basePath}/${slug}`, 'board.column', {
        label: label.trim(),
        color: 'border-zinc-400',
        order: maxOrder + 1,
        mount: { $type: 't.mount.query', source: `${basePath}/data`, match: { status: slug } },
      });
    }, `Column "${label.trim()}" created`);
  };

  const handleDragStart = (event: DragStartEvent) => {
    const data = event.active.data.current;
    if (data?.type === 'column') return;
    const task = data?.task;
    if (task && typeof task === 'object' && '$path' in task) {
      setActiveTask(task as NodeData);
    }
  };

  const handleDragOver = (event: DragOverEvent) => {
    const status = event.over?.data.current?.status;
    setOverStatus(typeof status === 'string' ? status : null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveTask(null);
    setOverStatus(null);
    const { active, over } = event;
    if (!over) return;

    const activeData = active.data.current;
    const overData = over.data.current;

    // ── column reorder (fractional order — single patch) ──
    if (activeData?.type === 'column' && overData?.type === 'column') {
      const fromPath = String(activeData.path);
      const toPath = String(overData.path);
      if (fromPath === toPath) return;
      const fromIdx = columns.findIndex(c => c.$path === fromPath);
      const toIdx = columns.findIndex(c => c.$path === toPath);
      if (fromIdx < 0 || toIdx < 0) return;

      const reordered = arrayMove(columns, fromIdx, toIdx);
      const moved = reordered[toIdx];
      const getOrder = (c?: NodeData) =>
        c && typeof c.order === 'number' ? c.order : null;
      const prev = getOrder(reordered[toIdx - 1]);
      const next = getOrder(reordered[toIdx + 1]);

      let newOrder: number;
      if (prev !== null && next !== null) newOrder = (prev + next) / 2;
      else if (prev !== null) newOrder = prev + 1;
      else if (next !== null) newOrder = next - 1;
      else newOrder = 0;

      saves.path(moved.$path).onChange({ order: newOrder });
      return;
    }

    // ── task move (status change) ──
    const overId = String(over.id);
    const targetStatus =
      overData?.status ?? (overId.startsWith('col:') ? overId.slice(4) : undefined);
    if (typeof targetStatus !== 'string') return;

    if (!activeData?.task || typeof activeData.task !== 'object' || !('status' in activeData.task)) return;
    if (activeData.task.status === targetStatus) return;

    const taskPath = (activeData.task as NodeData).$path;
    withToast(() => execute(taskPath, 'move', { status: targetStatus }, 'board.task'));
  };

  return (
    <div className="view-full px-4 py-3">
      <div className="mb-3">
        <h2 className="text-lg font-bold">Task Board</h2>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={() => { setActiveTask(null); setOverStatus(null); }}
      >
        <SortableContext items={columns.map(c => c.$path)} strategy={horizontalListSortingStrategy}>
          <div className="flex gap-3 overflow-x-auto pb-2">
            {columns.map((col) => (
              <Render
                key={col.$path}
                value={col}
                onChange={saves.path(col.$path).onChange}
                onSelect={setSelectedTask}
                onCreate={handleCreate}
                editable={editable}
                overStatus={overStatus}
              />
            ))}
            {editable && (
              <button
                onClick={addColumn}
                className="flex min-w-32 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground hover:border-foreground/30 hover:text-foreground"
              >
                + Column
              </button>
            )}
          </div>
        </SortableContext>

        <DragOverlay dropAnimation={null}>
          {activeTask && (
            <div className="w-60 rotate-2 opacity-90 rounded-md border border-border bg-card px-3 py-2">
              <RenderContext name="react:card">
                <Render value={activeTask} />
              </RenderContext>
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {selectedTask && selectedNode && (
        <TaskDialog
          node={selectedNode}
          onChange={saves.path(selectedTask).onChange}
          onClose={() => setSelectedTask(null)}
        />
      )}

      {draft.node && (
        <TaskDialog
          node={draft.node}
          onChange={draft.onChange}
          onClose={draft.close}
          onSave={handleDraftSave}
        />
      )}
    </div>
  );
};

const KanbanEditWrap: View<BoardKanban> = (props) => <KanbanView {...props} editable />;
register('board.kanban', 'react:edit', KanbanEditWrap);
register('board.kanban', 'react', KanbanView);
