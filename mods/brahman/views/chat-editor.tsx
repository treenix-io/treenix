// Chat editor — WYSIWYG Telegram-style editor for page actions
// Registered as react:chat:edit for brahman.page
// Same visual as PageChatPreview but with inline editing

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
import { getDefaults } from '@treenity/core/comp';
import type { NodeData } from '@treenity/core/core';
import { set, useChildren, usePath } from '@treenity/react/hooks';
import { trpc } from '@treenity/react/trpc';
import { Camera, File, GripVertical, Mic, MoreHorizontal, Plus, Trash2, Video, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ACTION_TYPES, MENU_TYPES, type MenuButton, type MenuRow, type MenuType, type TString } from '../types';
import { actionIcon, actionSummary } from './action-cards';
import { TStringLineInput, tstringPreview } from './tstring-input';

// ── Helpers ──

function tstr(ts: TString | undefined): string {
  if (!ts) return '';
  return ts.ru || ts.en || Object.values(ts).find(v => v) || '';
}

function primaryLang(ts: TString | undefined): string {
  if (!ts) return 'ru';
  if (ts.ru) return 'ru';
  if (ts.en) return 'en';
  return Object.keys(ts)[0] ?? 'ru';
}

// ── TgHtml — safe Telegram HTML renderer ──

const TG_TAGS: Record<string, string> = {
  b: 'font-bold', strong: 'font-bold',
  i: 'italic', em: 'italic',
  u: 'underline', ins: 'underline',
  s: 'line-through', strike: 'line-through', del: 'line-through',
  code: 'font-mono text-[13px] bg-[#1a2636] px-1 rounded',
  pre: 'font-mono text-[13px] bg-[#1a2636] p-2 rounded block overflow-x-auto',
  blockquote: 'border-l-2 border-[#3d6a99] pl-2 italic',
};

function domToReact(node: Node, key: number): React.ReactNode {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (tag === 'br') return <br key={key} />;
  if (tag === 'a') {
    const href = el.getAttribute('href') || '#';
    return <a key={key} href={href} target="_blank" rel="noopener noreferrer" className="text-[#5b9bd5] underline">{Array.from(el.childNodes).map(domToReact)}</a>;
  }
  const cls = TG_TAGS[tag];
  if (cls) return <span key={key} className={cls}>{Array.from(el.childNodes).map(domToReact)}</span>;
  return Array.from(el.childNodes).map(domToReact);
}

function TgHtml({ text }: { text: string }) {
  if (!/<[a-z][\s>]/i.test(text)) return <>{text}</>;
  const doc = new DOMParser().parseFromString(text, 'text/html');
  return <>{Array.from(doc.body.childNodes).map(domToReact)}</>;
}

// ── Editable text — click to edit, blur to save ──

// Sanitize browser-generated HTML back to Telegram-safe subset
const ALLOWED_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'code', 'pre', 'a', 'blockquote', 'br']);

function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  function walk(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    const inner = Array.from(el.childNodes).map(walk).join('');

    if (tag === 'br') return '\n';
    if (tag === 'div' || tag === 'p') return inner ? inner + '\n' : '';
    if (!ALLOWED_TAGS.has(tag)) return inner;
    if (tag === 'a') {
      const href = el.getAttribute('href');
      return href ? `<a href="${href}">${inner}</a>` : inner;
    }
    return `<${tag}>${inner}</${tag}>`;
  }

  return walk(doc.body).replace(/\n$/, '');
}

function EditableText({
  value,
  onChange,
  placeholder = 'Type message...',
}: {
  value: TString;
  onChange: (ts: TString) => void;
  placeholder?: string;
}) {
  const lang = primaryLang(value);
  const text = value[lang] ?? '';
  const ref = useRef<HTMLDivElement>(null);
  const saving = useRef(false);

  function save() {
    if (saving.current || !ref.current) return;
    saving.current = true;
    const html = ref.current.innerHTML;
    const clean = sanitizeHtml(html);
    if (clean !== text) onChange({ ...value, [lang]: clean });
    saving.current = false;
  }

  return (
    <div
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      className="outline-none min-h-[1.25rem] cursor-text
        focus:ring-1 focus:ring-[#3d6a99] rounded transition-all
        empty:before:content-[attr(data-placeholder)] empty:before:text-[#6c7883] empty:before:italic"
      data-placeholder={placeholder}
      dangerouslySetInnerHTML={{ __html: text || '' }}
      onBlur={save}
    />
  );
}

// ── Bubble shells ──

function BotBubble({ children, first, tools }: { children: React.ReactNode; first?: boolean; tools?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-start max-w-[85%] group/bubble">
      {first && <span className="text-[11px] font-semibold text-[#5b9bd5] mb-0.5 ml-1">Bot</span>}
      <div className="relative bg-[#182533] text-[#e1e3e6] text-sm rounded-lg rounded-tl-sm px-3 py-2 whitespace-pre-wrap break-words w-full">
        {children}
        {tools && (
          <div className="absolute -right-1 -top-1 opacity-0 group-hover/bubble:opacity-100 transition-opacity">
            {tools}
          </div>
        )}
      </div>
    </div>
  );
}

function UserBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-end">
      <div className="bg-[#2b5278] text-[#e1e3e6] text-sm rounded-lg rounded-tr-sm px-3 py-2 max-w-[70%]
        border border-dashed border-[#3d6a99] opacity-60">
        {children}
      </div>
    </div>
  );
}

function SystemPill({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
  return (
    <div className="flex justify-center">
      <div
        className={`flex items-center gap-1.5 text-[11px] text-[#6c7883] bg-[#131c26] rounded-full px-3 py-1 ${
          onClick ? 'cursor-pointer hover:bg-[#1a2636] hover:text-[#e1e3e6] transition-colors' : ''
        }`}
        onClick={onClick}
      >
        {children}
      </div>
    </div>
  );
}

// ── Settings popover ──

function SettingsPopover({
  node,
  onUpdate,
  onDelete,
  onClose,
}: {
  node: NodeData;
  onUpdate: (patch: Record<string, unknown>) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const type = node.$type;

  return createPortal(
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div
        className="absolute bg-[#1c2733] border border-[#2b3945] rounded-lg shadow-xl p-3 space-y-2 w-64"
        style={{ top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-medium text-[#e1e3e6]">
            {ACTION_TYPES.find(a => a.type === type)?.label ?? type.split('.').at(-1)}
          </span>
          <button type="button" onClick={onClose} className="text-[#6c7883] hover:text-[#e1e3e6]">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Type-specific settings */}
        {type === 'brahman.action.message' && (
          <>
            <SettingSelect label="Menu" value={(node.menuType as string) ?? 'none'}
              options={MENU_TYPES.map(m => ({ value: m.value, label: m.label }))}
              onChange={v => onUpdate({ menuType: v })} />
            <SettingCheckbox label="Disable links" checked={!!node.disableLinks}
              onChange={v => onUpdate({ disableLinks: v })} />
          </>
        )}

        {type === 'brahman.action.question' && (
          <>
            <SettingSelect label="Input type" value={(node.inputType as string) ?? 'text'}
              options={[{ value: 'text', label: 'Text' }, { value: 'photo', label: 'Photo' }]}
              onChange={v => onUpdate({ inputType: v })} />
            <SettingInput label="Save to" value={(node.saveTo as string) ?? ''}
              placeholder="session.field" onChange={v => onUpdate({ saveTo: v })} />
          </>
        )}

        {type === 'brahman.action.file' && (
          <SettingSelect label="Send as" value={(node.asType as string) ?? ''}
            options={[
              { value: '', label: 'Auto' }, { value: 'photo', label: 'Photo' },
              { value: 'document', label: 'Document' }, { value: 'video', label: 'Video' },
              { value: 'audio', label: 'Audio' }, { value: 'voice', label: 'Voice' },
            ]}
            onChange={v => onUpdate({ asType: v })} />
        )}

        <div className="pt-1 border-t border-[#2b3945]">
          <button
            type="button"
            onClick={onDelete}
            className="flex items-center gap-1.5 text-xs text-red-400 hover:text-red-300 py-1"
          >
            <Trash2 className="h-3 w-3" /> Delete action
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function SettingSelect({ label, value, options, onChange }: {
  label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[11px] text-[#6c7883]">{label}</span>
      <select
        className="bg-[#0e1621] border border-[#2b3945] rounded text-xs text-[#e1e3e6] px-2 py-1"
        value={value} onChange={e => onChange(e.target.value)}
      >
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

function SettingCheckbox({ label, checked, onChange }: {
  label: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2 cursor-pointer">
      <span className="text-[11px] text-[#6c7883]">{label}</span>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)}
        className="rounded border-[#2b3945]" />
    </label>
  );
}

function SettingInput({ label, value, placeholder, onChange }: {
  label: string; value: string; placeholder?: string; onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[11px] text-[#6c7883] shrink-0">{label}</span>
      <input
        className="bg-[#0e1621] border border-[#2b3945] rounded text-xs text-[#e1e3e6] px-2 py-1 w-32 font-mono"
        value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)}
      />
    </div>
  );
}

// ── Editable inline buttons ──

function EditableButtons({
  rows,
  menuType,
  onChangeRows,
}: {
  rows: MenuRow[];
  menuType: MenuType;
  onChangeRows: (rows: MenuRow[]) => void;
}) {
  const [editBtn, setEditBtn] = useState<{ ri: number; bi: number } | null>(null);

  if (!rows?.length || menuType === 'none' || menuType === 'remove') return null;
  const isReply = menuType === 'keyboard' || menuType === 'force_reply';

  let nextId = 1;
  for (const row of rows) for (const btn of row.buttons) if (btn.id >= nextId) nextId = btn.id + 1;

  function addButton(ri: number) {
    const newRows = rows.map(r => ({ buttons: [...r.buttons] }));
    newRows[ri].buttons.push({ id: nextId, title: { ru: '', en: '' }, tags: [] });
    onChangeRows(newRows);
  }

  function addRow() {
    onChangeRows([...rows, { buttons: [{ id: nextId, title: { ru: '', en: '' }, tags: [] }] }]);
  }

  function updateButton(ri: number, bi: number, btn: MenuButton) {
    const newRows = rows.map(r => ({ buttons: [...r.buttons] }));
    newRows[ri].buttons[bi] = btn;
    onChangeRows(newRows);
  }

  function deleteButton(ri: number, bi: number) {
    const newRows = rows.map(r => ({ buttons: [...r.buttons] }));
    newRows[ri].buttons.splice(bi, 1);
    onChangeRows(newRows.filter(r => r.buttons.length > 0));
    setEditBtn(null);
  }

  return (
    <div className={`flex flex-col gap-0.5 ${isReply ? 'w-full mt-2' : 'max-w-[85%] mt-0.5'}`}>
      {rows.map((row, ri) => (
        <div key={ri} className="flex gap-0.5">
          {row.buttons.map((btn, bi) => {
            const text = tstringPreview(btn.title, 24) || '...';
            return (
              <div
                key={btn.id}
                className={`flex-1 text-center text-xs py-1.5 px-2 rounded truncate cursor-pointer
                  hover:ring-1 hover:ring-[#5b9bd5] transition-all
                  ${isReply
                    ? 'bg-[#1c2733] text-[#e1e3e6] border border-[#2b3945]'
                    : 'bg-[#2b5278] text-[#e1e3e6]'
                  }`}
                onClick={() => setEditBtn({ ri, bi })}
              >
                {btn.url ? `🔗 ${text}` : text}
              </div>
            );
          })}
          <button
            type="button"
            onClick={() => addButton(ri)}
            className="text-[#6c7883] hover:text-[#e1e3e6] px-1 transition-colors"
            title="Add button"
          >
            <Plus className="h-3 w-3" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={addRow}
        className="text-[10px] text-[#6c7883] hover:text-[#e1e3e6] py-0.5 transition-colors"
      >
        + row
      </button>

      {/* Button edit modal */}
      {editBtn && rows[editBtn.ri]?.buttons[editBtn.bi] && (
        <ButtonEditPopover
          button={rows[editBtn.ri].buttons[editBtn.bi]}
          onSave={btn => updateButton(editBtn.ri, editBtn.bi, btn)}
          onDelete={() => deleteButton(editBtn.ri, editBtn.bi)}
          onClose={() => setEditBtn(null)}
        />
      )}
    </div>
  );
}

function ButtonEditPopover({
  button,
  onSave,
  onDelete,
  onClose,
}: {
  button: MenuButton;
  onSave: (btn: MenuButton) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState({ ...button });

  return createPortal(
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div
        className="absolute bg-[#1c2733] border border-[#2b3945] rounded-lg shadow-xl p-3 space-y-2 w-72"
        style={{ top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-medium text-[#e1e3e6]">Edit button</span>
          <button type="button" onClick={onClose} className="text-[#6c7883] hover:text-[#e1e3e6]">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div>
          <span className="text-[11px] text-[#6c7883]">Title</span>
          <TStringLineInput
            value={draft.title}
            onChange={title => setDraft(d => ({ ...d, title }))}
            langs={['ru', 'en']}
          />
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[11px] text-[#6c7883] shrink-0">URL</span>
          <input
            className="flex-1 bg-[#0e1621] border border-[#2b3945] rounded text-xs text-[#e1e3e6] px-2 py-1"
            placeholder="https://..."
            value={draft.url ?? ''}
            onChange={e => setDraft(d => ({ ...d, url: e.target.value || undefined }))}
          />
        </div>

        <div className="flex justify-between pt-1 border-t border-[#2b3945]">
          <button type="button" onClick={onDelete}
            className="text-xs text-red-400 hover:text-red-300 flex items-center gap-1">
            <Trash2 className="h-3 w-3" /> Delete
          </button>
          <div className="flex gap-1">
            <button type="button" onClick={onClose}
              className="text-xs text-[#6c7883] hover:text-[#e1e3e6] px-2 py-1">Cancel</button>
            <button type="button" onClick={() => { onSave(draft); onClose(); }}
              className="text-xs bg-[#2b5278] text-[#e1e3e6] px-3 py-1 rounded hover:bg-[#3d6a99]">Save</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Sortable action wrapper ──

function SortableAction({
  node,
  isFirstBubble,
  onDelete,
}: {
  node: NodeData;
  isFirstBubble: boolean;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: node.$path });
  const n = usePath(node.$path);
  const [showSettings, setShowSettings] = useState(false);

  if (!n) return null;

  function update(patch: Record<string, unknown>) {
    if (!n) return;
    set({ ...n, ...patch } as NodeData);
  }

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  const settingsBtn = (
    <button
      type="button"
      onClick={e => { e.stopPropagation(); setShowSettings(true); }}
      className="bg-[#1c2733] border border-[#2b3945] rounded-full p-1 text-[#6c7883] hover:text-[#e1e3e6] transition-colors"
    >
      <MoreHorizontal className="h-3 w-3" />
    </button>
  );

  const dragHandle = (
    <div
      {...attributes}
      {...listeners}
      className="absolute -left-5 top-1/2 -translate-y-1/2 opacity-0 group-hover/action:opacity-100
        cursor-grab text-[#6c7883] hover:text-[#e1e3e6] transition-opacity"
    >
      <GripVertical className="h-3.5 w-3.5" />
    </div>
  );

  const type = n.$type;

  const content = (() => {
    switch (type) {
      case 'brahman.action.message': {
        const menuType = (n.menuType as MenuType) ?? 'none';
        const rows = (n.rows as MenuRow[]) ?? [];
        return (
          <div className="flex flex-col items-start gap-0">
            <BotBubble first={isFirstBubble} tools={settingsBtn}>
              <EditableText
                value={(n.text as TString) ?? {}}
                onChange={text => update({ text })}
                placeholder="Type message..."
              />
            </BotBubble>
            <EditableButtons
              rows={rows}
              menuType={menuType}
              onChangeRows={rows => update({ rows })}
            />
          </div>
        );
      }

      case 'brahman.action.question': {
        const inputType = (n.inputType as string) ?? 'text';
        return (
          <div className="space-y-1.5">
            <BotBubble first={isFirstBubble} tools={settingsBtn}>
              <EditableText
                value={(n.text as TString) ?? {}}
                onChange={text => update({ text })}
                placeholder="Type question..."
              />
            </BotBubble>
            <UserBubble>
              {inputType === 'photo'
                ? <span className="flex items-center gap-1"><Camera className="h-3.5 w-3.5" /> Photo</span>
                : <span className="italic text-xs">User types answer...</span>
              }
            </UserBubble>
          </div>
        );
      }

      case 'brahman.action.file': {
        const asType = (n.asType as string) || 'document';
        const icons: Record<string, React.ReactNode> = {
          photo: <Camera className="h-8 w-8" />,
          video: <Video className="h-8 w-8" />,
          audio: <Mic className="h-8 w-8" />,
          voice: <Mic className="h-8 w-8" />,
        };
        return (
          <BotBubble first={isFirstBubble} tools={settingsBtn}>
            <div className="flex flex-col items-center gap-1 py-2 text-[#6c7883]">
              {icons[asType] ?? <File className="h-8 w-8" />}
              <span className="text-xs">{asType}</span>
            </div>
          </BotBubble>
        );
      }

      case 'brahman.action.selectlang': {
        return (
          <div className="flex flex-col items-start gap-0.5">
            <BotBubble first={isFirstBubble} tools={settingsBtn}>
              <EditableText
                value={(n.text as TString) ?? {}}
                onChange={text => update({ text })}
                placeholder="Choose language"
              />
            </BotBubble>
            <div className="flex gap-0.5 max-w-[85%]">
              <div className="flex-1 text-center text-xs py-1.5 px-2 rounded bg-[#2b5278] text-[#e1e3e6]">🇷🇺 RU</div>
              <div className="flex-1 text-center text-xs py-1.5 px-2 rounded bg-[#2b5278] text-[#e1e3e6]">🇬🇧 EN</div>
            </div>
          </div>
        );
      }

      // All other actions → system pills
      default: {
        const summary = actionSummary(n);
        const label = type.split('.').at(-1) ?? type;
        return (
          <SystemPill onClick={() => setShowSettings(true)}>
            {actionIcon(type)}
            <span>{label}{summary ? `: ${summary}` : ''}</span>
          </SystemPill>
        );
      }
    }
  })();

  return (
    <div ref={setNodeRef} style={style} className="relative group/action">
      {dragHandle}
      {content}
      {showSettings && (
        <SettingsPopover
          node={n}
          onUpdate={update}
          onDelete={onDelete}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}

// ── Action palette (compact, chat-themed) ──

function ChatActionPalette({ onSelect }: { onSelect: (type: string) => void }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex justify-center">
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1 text-[11px] text-[#6c7883] hover:text-[#e1e3e6]
            bg-[#131c26] rounded-full px-3 py-1 transition-colors"
        >
          <Plus className="h-3 w-3" /> Add action
        </button>

        {open && (
          <div className="absolute left-1/2 -translate-x-1/2 bottom-full mb-1 z-50 w-52
            bg-[#1c2733] border border-[#2b3945] rounded-lg shadow-xl py-1 max-h-64 overflow-y-auto">
            {ACTION_TYPES.map(at => (
              <button
                key={at.type}
                type="button"
                className="w-full text-left px-3 py-1.5 text-xs text-[#e1e3e6] hover:bg-[#2b3945] flex items-center gap-2"
                onClick={() => { onSelect(at.type); setOpen(false); }}
              >
                {actionIcon(at.type)}
                {at.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main component ──

export function PageChatEditor({ value }: { value: NodeData }) {
  const node = usePath(value.$path);
  const actionsPath = value.$path + '/_actions';
  const children = useChildren(actionsPath, { watch: true, watchNew: true });

  const positions: string[] = (node?.positions as string[]) ?? [];
  const tracked = new Set(positions);
  const sorted = [
    ...positions.map(p => children.find(c => c.$path === p)).filter((c): c is NodeData => !!c),
    ...children.filter(c => !tracked.has(c.$path) && c.$type?.startsWith('brahman.action.')),
  ];

  // ── Command editing ──
  const command = (node?.command as string) ?? '';
  const [localCmd, setLocalCmd] = useState(command);
  const cmdTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => { setLocalCmd(command); }, [command]);

  const saveNode = useCallback((patch: Record<string, unknown>) => {
    if (!node) return;
    set({ ...node, ...patch } as NodeData);
  }, [node]);

  // ── DnD ──
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
    saveNode({ positions: arrayMove(sorted.map(c => c.$path), oldIndex, newIndex) });
  }

  // ── CRUD ──
  async function addAction(type: string) {
    const id = Date.now().toString(36);
    const childPath = `${actionsPath}/${id}`;
    await trpc.set.mutate({ node: { $path: actionsPath, $type: 'dir' } as NodeData });
    const defaults = getDefaults(type);
    await trpc.set.mutate({ node: { $path: childPath, $type: type, ...defaults } as NodeData });
    saveNode({ positions: [...positions, childPath] });
  }

  async function removeAction(path: string) {
    await trpc.remove.mutate({ path });
    saveNode({ positions: positions.filter(p => p !== path) });
  }

  let hadBotBubble = false;

  return (
    <div className="bg-[#0e1621] rounded-xl p-4 space-y-2.5 min-h-[200px] max-w-md mx-auto">
      {/* Command header — editable */}
      <div className="flex justify-center mb-2">
        <input
          className="text-[11px] text-[#6c7883] bg-[#131c26] rounded-full px-3 py-1 font-mono
            text-center border-none outline-none focus:ring-1 focus:ring-[#3d6a99] w-32"
          placeholder="/start"
          value={localCmd}
          onChange={e => {
            setLocalCmd(e.target.value);
            clearTimeout(cmdTimer.current);
            cmdTimer.current = setTimeout(() => saveNode({ command: e.target.value }), 400);
          }}
          onBlur={() => {
            clearTimeout(cmdTimer.current);
            if (localCmd !== command) saveNode({ command: localCmd });
          }}
        />
      </div>

      {/* Actions with DnD */}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={sorted.map(c => c.$path)} strategy={verticalListSortingStrategy}>
          <div className="space-y-2.5">
            {sorted.length === 0 && (
              <div className="text-[#6c7883] text-xs text-center py-8">Click + to add actions</div>
            )}

            {sorted.map(child => {
              const isBubbleType = ['brahman.action.message', 'brahman.action.question',
                'brahman.action.file', 'brahman.action.selectlang'].includes(child.$type);
              const isFirstBubble = isBubbleType && !hadBotBubble;
              if (isBubbleType) hadBotBubble = true;

              return (
                <SortableAction
                  key={child.$path}
                  node={child}
                  isFirstBubble={isFirstBubble}
                  onDelete={() => removeAction(child.$path)}
                />
              );
            })}
          </div>
        </SortableContext>
      </DndContext>

      {/* Add action */}
      <ChatActionPalette onSelect={addAction} />

      {/* Input bar mockup */}
      <div className="flex items-center gap-2 mt-4 pt-3 border-t border-[#1c2733]">
        <div className="flex-1 bg-[#1c2733] rounded-full px-3 py-1.5 text-xs text-[#6c7883]">
          Message...
        </div>
      </div>
    </div>
  );
}
