// Page layout — DnD sortable list of actions
// Data model: command & positions are TOP-LEVEL node fields (not in a component).
// getComponent(node, PageConfig) returns the node itself when node.$type === 'brahman.page',
// so data must be on the node, not nested in node.page.

import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { NodeData } from '@treenx/core';
import { getDefaults } from '@treenx/core/comp';
import { Button } from '@treenx/react/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@treenx/react/components/ui/dropdown-menu';
import { Input } from '@treenx/react/components/ui/input';
import { Render } from '@treenx/react';
import { set, useChildren, useNavigate, usePath } from '@treenx/react';
import { trpc } from '@treenx/react';
import { ChevronDown, ChevronRight, GripVertical, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ACTION_TYPES } from '../types';
import { actionIcon, actionSummary } from './action-cards';

// ── Action palette dropdown ──

function ActionPalette({ onSelect }: { onSelect: (type: string) => void }) {
  const [filter, setFilter] = useState('');
  const q = filter.trim().toLowerCase();
  const items = q
    ? ACTION_TYPES.filter(at => at.label.toLowerCase().includes(q) || at.type.toLowerCase().includes(q))
    : ACTION_TYPES;

  return (
    <DropdownMenu onOpenChange={(open) => { if (!open) setFilter(''); }}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus className="h-4 w-4 mr-1" /> Add action
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56 p-0">
        <div className="p-1.5 border-b border-border">
          <Input
            autoFocus
            value={filter}
            onChange={e => setFilter(e.target.value)}
            onKeyDown={e => e.stopPropagation()}
            placeholder="Filter..."
            className="h-7 text-sm"
          />
        </div>
        <div className="py-1 max-h-180 overflow-y-auto">
          {items.length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">No matches</div>
          ) : items.map(at => (
            <DropdownMenuItem
              key={at.type}
              onSelect={() => onSelect(at.type)}
              className="flex items-center gap-2"
            >
              {actionIcon(at.type)}
              {at.label}
            </DropdownMenuItem>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── Sortable action card ──

function SortableAction({
  node,
  onRemove,
  onSelect,
  expanded,
  onToggle,
}: {
  node: NodeData;
  onRemove: () => void;
  onSelect: () => void;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: node.$path });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className="bg-card border border-border rounded-md group hover:border-primary/50"
    >
      {/* Header row */}
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer"
        onClick={onToggle}
      >
        <div {...attributes} {...listeners} className="cursor-grab text-muted-foreground hover:text-foreground"
          onClick={e => e.stopPropagation()}>
          <GripVertical className="h-4 w-4" />
        </div>

        <div className="text-muted-foreground">
          {expanded
            ? <ChevronDown className="h-3.5 w-3.5" />
            : <ChevronRight className="h-3.5 w-3.5" />}
        </div>

        <div className="flex items-center gap-2 flex-1 min-w-0">
          {actionIcon(node.$type)}
          <span className="text-xs font-medium text-muted-foreground uppercase">
            {ACTION_TYPES.find(a => a.type === node.$type)?.label ?? node.$type.split('.').at(-1)}
          </span>
          {!expanded && (
            <span className="text-sm truncate text-foreground/60">{actionSummary(node)}</span>
          )}
        </div>

        <Button
          variant="ghost"
          size="sm"
          className="p-0 h-auto text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100"
          onClick={e => { e.stopPropagation(); onSelect(); }}
          title="Select in tree"
        >
          &#8599;
        </Button>

        <Button
          variant="ghost"
          size="sm"
          className="p-0 h-auto opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
          onClick={e => { e.stopPropagation(); onRemove(); }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Inline editor */}
      {expanded && (
        <div className="px-3 pb-3 border-t border-border/50 pt-3">
          <Render value={node} />
        </div>
      )}
    </div>
  );
}

// ── Page layout view (registered as 'brahman.page' react handler) ──

export function PageLayoutView({ value }: { value: NodeData }) {
  const navigate = useNavigate();
  const { data: node } = usePath(value.$path);
  const actionsPath = value.$path + '/_actions';
  const { data: children } = useChildren(actionsPath, { watch: true, watchNew: true });
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Read command & positions from node top-level (getComponent returns node itself)
  const command = (node?.command as string) ?? '';
  const positions: string[] = (node?.positions as string[]) ?? [];

  // Debounced save: update local state immediately, persist after 400ms idle
  const [localCommand, setLocalCommand] = useState(command);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Sync local state when node changes externally
  useEffect(() => { setLocalCommand(command); }, [command]);

  const saveNode = useCallback((patch: Record<string, unknown>) => {
    if (!node) return;
    // Strip any leftover 'page' component that shouldn't exist
    const { page: _drop, ...clean } = node;
    set({ ...clean, ...patch } as NodeData);
  }, [node]);

  const debouncedSave = useCallback((patch: Record<string, unknown>) => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => saveNode(patch), 400);
  }, [saveNode]);

  // Cleanup timer on unmount
  useEffect(() => () => clearTimeout(timerRef.current), []);

  // Sort children by positions, append any untracked
  const tracked = new Set(positions);
  const sorted = [
    ...positions.map(p => children.find(c => c.$path === p)).filter((c): c is NodeData => !!c),
    ...children.filter(c => !tracked.has(c.$path) && c.$type?.startsWith('brahman.action.')),
  ];

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = sorted.findIndex(c => c.$path === active.id);
    const newIndex = sorted.findIndex(c => c.$path === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(sorted.map(c => c.$path), oldIndex, newIndex);
    saveNode({ positions: reordered });
  }

  async function addAction(type: string) {
    const id = Date.now().toString(36);
    const childPath = `${actionsPath}/${id}`;

    // Ensure _actions dir exists as a real node
    await trpc.set.mutate({ node: { $path: actionsPath, $type: 'dir' } as NodeData });

    const defaults = getDefaults(type);

    // Data on the node directly (findActionComp returns node when $type matches)
    await trpc.set.mutate({
      node: { $path: childPath, $type: type, ...defaults } as NodeData,
    });

    saveNode({ positions: [...positions, childPath] });
  }

  async function removeAction(path: string) {
    await trpc.remove.mutate({ path });
    saveNode({ positions: positions.filter(p => p !== path) });
  }

  function selectAction(path: string) {
    navigate(path);
  }

  return (
    <div className="space-y-4 max-w-2xl">
      {/* Page command */}
      <div className="flex items-center gap-3">
        <label className="text-sm font-medium text-muted-foreground w-20">Command</label>
        <Input
          className="flex-1 font-mono"
          placeholder="/command..."
          value={localCommand}
          onChange={e => {
            setLocalCommand(e.target.value);
            debouncedSave({ command: e.target.value });
          }}
          onBlur={() => {
            // Flush pending save on blur
            clearTimeout(timerRef.current);
            if (localCommand !== command) saveNode({ command: localCommand });
          }}
        />
      </div>

      {/* Actions list */}
      <div className="space-y-1.5">
        <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
          Actions ({sorted.length})
        </div>

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={sorted.map(c => c.$path)} strategy={verticalListSortingStrategy}>
            <div className="space-y-1">
              {sorted.map(child => (
                <SortableAction
                  key={child.$path}
                  node={child}
                  onRemove={() => removeAction(child.$path)}
                  onSelect={() => selectAction(child.$path)}
                  expanded={!collapsed.has(child.$path)}
                  onToggle={() => setCollapsed(prev => {
                    const next = new Set(prev);
                    if (next.has(child.$path)) next.delete(child.$path);
                    else next.add(child.$path);
                    return next;
                  })}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>

        {sorted.length === 0 && (
          <div className="text-sm text-muted-foreground text-center py-8 border border-dashed border-border rounded-md">
            No actions yet. Add one below.
          </div>
        )}
      </div>

      <ActionPalette onSelect={addAction} />
    </div>
  );
}
