// Menu editor — DnD button/row constructor
// Per-row horizontal sortable + cross-row drop with indicator

import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { arrayMove, horizontalListSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Badge } from '@treenity/react/components/ui/badge';
import { Button } from '@treenity/react/components/ui/button';
import { Input } from '@treenity/react/components/ui/input';
import { trpc } from '@treenity/react/trpc';
import { ArrowRight, Plus, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ACTION_TYPES, MENU_TYPES, type MenuButton, type MenuRow, type MenuType, type TString } from '../types';
import { TStringLineInput, tstringPreview } from './tstring-input';

// ── Modal (lightweight, no radix dependency) ──

function Modal({ open, onClose, title, children }: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-background border border-border rounded-lg shadow-lg w-full max-w-md mx-4">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-sm font-semibold">{title}</h3>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-4 space-y-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

// ── Tag editor (for button tags) ──

function TagEditor({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const [input, setInput] = useState('');

  function add() {
    const t = input.trim();
    if (!t || tags.includes(t)) return;
    onChange([...tags, t]);
    setInput('');
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1">
        {tags.map(tag => (
          <Badge key={tag} variant="secondary" className="gap-1 pr-1 text-xs">
            {tag}
            <button type="button" onClick={() => onChange(tags.filter(t => t !== tag))}
              className="ml-0.5 rounded-full hover:bg-destructive/20 p-0.5">
              <X className="h-2.5 w-2.5" />
            </button>
          </Badge>
        ))}
      </div>
      <div className="flex gap-1">
        <Input className="flex-1 h-7 text-xs" placeholder="tag (!exclude)" value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), add())} />
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={add}>+</Button>
      </div>
    </div>
  );
}

// ── Button edit modal ──

function ButtonEditModal({
  button,
  langs,
  onSave,
  onDelete,
  onClose,
}: {
  button: MenuButton;
  langs: string[];
  onSave: (btn: MenuButton) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<MenuButton>({ ...button });

  function update<K extends keyof MenuButton>(key: K, val: MenuButton[K]) {
    setDraft(prev => ({ ...prev, [key]: val }));
  }

  return (
    <Modal open title="Edit Button" onClose={onClose}>
      <div className="space-y-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground">Title</label>
          <TStringLineInput value={draft.title} onChange={t => update('title', t)} langs={langs} />
        </div>

        <div>
          <label className="text-xs font-medium text-muted-foreground">URL (optional)</label>
          <Input className="h-8 text-sm" placeholder="https://..."
            value={draft.url ?? ''} onChange={e => update('url', e.target.value || undefined)} />
        </div>

        <div>
          <label className="text-xs font-medium text-muted-foreground">Tags</label>
          <TagEditor tags={draft.tags ?? []} onChange={t => update('tags', t)} />
        </div>

        <div>
          <label className="text-xs font-medium text-muted-foreground">Button action</label>
          <select
            className="w-full h-8 text-sm border border-border rounded-md bg-background px-2"
            value={draft.action?.type ?? ''}
            onChange={e => {
              if (!e.target.value) { update('action', undefined); return; }
              update('action', { type: e.target.value });
            }}
          >
            <option value="">No action</option>
            {ACTION_TYPES.map(at => (
              <option key={at.type} value={at.type}>{at.label}</option>
            ))}
          </select>

          {draft.action?.type === 'brahman.action.page' && (
            <Input className="h-8 text-sm mt-1" placeholder="Target page path"
              value={(draft.action.target as string) ?? ''}
              onChange={e => update('action', { ...draft.action!, target: e.target.value })} />
          )}
        </div>
      </div>

      <div className="flex justify-between pt-2">
        <Button variant="destructive" size="sm" onClick={onDelete}>Delete</Button>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={() => { onSave(draft); onClose(); }}>Save</Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Sortable button with drop indicator ──

function SortableButton({
  button,
  totalInRow,
  onClick,
  onPageDrop,
  isOver,
  isCrossRow,
}: {
  button: MenuButton;
  totalInRow: number;
  onClick: () => void;
  onPageDrop: (path: string) => void;
  isOver: boolean;
  isCrossRow: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `btn-${button.id}`,
  });
  const [treeDragOver, setTreeDragOver] = useState(false);

  const widthPct = `${(100 / totalInRow).toFixed(1)}%`;
  const showIndicator = isOver && isCrossRow;
  const pageTarget = button.action?.type === 'brahman.action.page' ? button.action.target as string : null;

  return (
    <div
      ref={setNodeRef}
      style={{
        width: widthPct,
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.3 : 1,
      }}
      className={`shrink-0 relative ${showIndicator ? 'ml-2' : ''}`}
      onDragOver={e => {
        if (e.dataTransfer.types.includes('application/treenity-path')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'link';
          setTreeDragOver(true);
        }
      }}
      onDragLeave={() => setTreeDragOver(false)}
      onDrop={async e => {
        const path = e.dataTransfer.getData('application/treenity-path');
        setTreeDragOver(false);
        if (!path) return;
        e.preventDefault();
        const node = await trpc.get.query({ path });
        if (node?.$type === 'brahman.page') onPageDrop(path);
      }}
    >
      {showIndicator && (
        <div className="absolute -left-2 top-0 bottom-0 flex items-center z-10">
          <div className="w-1 h-full bg-primary rounded-full" />
        </div>
      )}
      <div
        {...attributes}
        {...listeners}
        onClick={onClick}
        className={`flex flex-wrap items-center justify-center gap-x-1.5 gap-y-0 px-2 py-1.5 border rounded-md
          cursor-pointer text-sm font-medium select-none transition-colors
          ${treeDragOver ? 'border-primary bg-primary/10 ring-1 ring-primary/30' : ''}
          ${showIndicator ? 'border-primary/50 bg-primary/5' : ''}
          ${!treeDragOver && !showIndicator ? 'border-border bg-card hover:bg-accent' : ''}`}
      >
        <span className="truncate">
          {tstringPreview(button.title, 20) || 'Button'}
        </span>
        {(button.tags?.length ?? 0) > 0 && (
          <span className="text-[9px] text-muted-foreground">({button.tags!.length})</span>
        )}
        {pageTarget && (
          <span className="flex items-center gap-0.5 text-[9px] text-primary/70">
            <ArrowRight className="h-2.5 w-2.5" />
            {pageTarget.split('/').at(-1)}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Helpers ──

function findButtonIn(rows: MenuRow[], id: string): { rowIdx: number; btnIdx: number } | null {
  const numId = parseInt(id.replace('btn-', ''), 10);
  for (let r = 0; r < rows.length; r++) {
    const bi = rows[r].buttons.findIndex(b => b.id === numId);
    if (bi >= 0) return { rowIdx: r, btnIdx: bi };
  }
  return null;
}

// ── Menu editor (main component) ──

type MenuEditorProps = {
  menuType: MenuType;
  rows: MenuRow[];
  langs: string[];
  onChangeType: (type: MenuType) => void;
  onChangeRows: (rows: MenuRow[]) => void;
};

export function MenuEditor({ menuType = 'none', rows = [], langs, onChangeType, onChangeRows }: MenuEditorProps) {
  const [editingButton, setEditingButton] = useState<{ rowIdx: number; btnIdx: number } | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Track which button we're hovering over (using ref to avoid re-render storms from @dnd-kit)
  const overIdRef = useRef<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const showRows = menuType !== 'none' && menuType !== 'remove';
  let nextId = 1;
  for (const row of rows) for (const btn of row.buttons) if (btn.id >= nextId) nextId = btn.id + 1;

  function defaultTitle(): TString {
    return Object.fromEntries(langs.map(l => [l, `Button ${nextId}`]));
  }

  // ── DnD handlers ──

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
    overIdRef.current = null;
    setOverId(null);
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const src = findButtonIn(rows, String(active.id));
      const dst = findButtonIn(rows, String(over.id));

      if (src && dst) {
        const newRows = rows.map(r => ({ buttons: [...r.buttons] }));

        if (src.rowIdx === dst.rowIdx) {
          newRows[src.rowIdx].buttons = arrayMove(newRows[src.rowIdx].buttons, src.btnIdx, dst.btnIdx);
        } else {
          const [btn] = newRows[src.rowIdx].buttons.splice(src.btnIdx, 1);
          newRows[dst.rowIdx].buttons.splice(dst.btnIdx, 0, btn);
        }

        onChangeRows(newRows.filter(r => r.buttons.length > 0));
      }
    }

    setActiveId(null);
    overIdRef.current = null;
    setOverId(null);
  }

  // ── CRUD ──

  function addButton(rowIdx: number) {
    const newRows = rows.map(r => ({ buttons: [...r.buttons] }));
    newRows[rowIdx].buttons.push({ id: nextId, title: defaultTitle(), tags: [] });
    onChangeRows(newRows);
  }

  function addRow() {
    onChangeRows([...rows, { buttons: [{ id: nextId, title: defaultTitle(), tags: [] }] }]);
  }

  function updateButton(rowIdx: number, btnIdx: number, btn: MenuButton) {
    const newRows = rows.map(r => ({ buttons: [...r.buttons] }));
    newRows[rowIdx].buttons[btnIdx] = btn;
    onChangeRows(newRows);
  }

  function deleteButton(rowIdx: number, btnIdx: number) {
    const newRows = rows.map(r => ({ buttons: [...r.buttons] }));
    newRows[rowIdx].buttons.splice(btnIdx, 1);
    onChangeRows(newRows.filter(r => r.buttons.length > 0));
    setEditingButton(null);
  }

  // Determine if active and over are in different rows
  const activePos = activeId ? findButtonIn(rows, activeId) : null;
  const overPos = overId ? findButtonIn(rows, overId) : null;
  const isCrossRow = !!(activePos && overPos && activePos.rowIdx !== overPos.rowIdx);

  return (
    <div className="space-y-3">
      {/* Menu type selector */}
      <div className="flex items-center gap-3">
        <label className="text-xs font-medium text-muted-foreground w-20">Menu type</label>
        <select
          className="flex-1 h-8 text-sm border border-border rounded-md bg-background px-2"
          value={menuType}
          onChange={e => onChangeType(e.target.value as MenuType)}
        >
          {MENU_TYPES.map(mt => (
            <option key={mt.value} value={mt.value}>{mt.label}</option>
          ))}
        </select>
      </div>

      {/* Rows & buttons grid */}
      {showRows && (
        <div className="space-y-2">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragMove={({ over }) => {
              const id = over ? String(over.id) : null;
              if (id !== overIdRef.current) {
                overIdRef.current = id;
                setOverId(id);
              }
            }}
            onDragEnd={handleDragEnd}
            onDragCancel={() => { setActiveId(null); overIdRef.current = null; setOverId(null); }}
          >
            {rows.map((row, ri) => (
              <div key={ri} className="space-y-1">
                <div className="flex items-center gap-1">
                  <span className="text-[10px] text-muted-foreground w-4">{ri + 1}</span>

                  <SortableContext
                    items={row.buttons.map(b => `btn-${b.id}`)}
                    strategy={horizontalListSortingStrategy}
                  >
                    <div className="flex-1 flex gap-1">
                      {row.buttons.map((btn, bi) => (
                        <SortableButton
                          key={btn.id}
                          button={btn}
                          totalInRow={row.buttons.length}
                          onClick={() => setEditingButton({ rowIdx: ri, btnIdx: bi })}
                          onPageDrop={path => updateButton(ri, bi, {
                            ...btn,
                            action: { type: 'brahman.action.page', target: path },
                          })}
                          isOver={overId === `btn-${btn.id}`}
                          isCrossRow={isCrossRow}
                        />
                      ))}
                    </div>
                  </SortableContext>

                  <button
                    type="button"
                    onClick={() => addButton(ri)}
                    className="p-1 text-muted-foreground hover:text-foreground"
                    title="Add button to row"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}

            <DragOverlay>
              {activeId && activePos ? (
                <div className="px-2 py-1.5 border border-primary rounded-md bg-card shadow-lg text-xs font-medium opacity-85">
                  {tstringPreview(rows[activePos.rowIdx].buttons[activePos.btnIdx].title, 12) || 'Button'}
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>

          <Button variant="outline" size="sm" className="text-xs" onClick={addRow}>
            <Plus className="h-3 w-3 mr-1" /> Add row
          </Button>
        </div>
      )}

      {/* Button edit modal */}
      {editingButton && rows[editingButton.rowIdx]?.buttons[editingButton.btnIdx] && (
        <ButtonEditModal
          button={rows[editingButton.rowIdx].buttons[editingButton.btnIdx]}
          langs={langs}
          onSave={btn => updateButton(editingButton.rowIdx, editingButton.btnIdx, btn)}
          onDelete={() => deleteButton(editingButton.rowIdx, editingButton.btnIdx)}
          onClose={() => setEditingButton(null)}
        />
      )}
    </div>
  );
}
