// Action type views — full editors (react) + compact cards (react:list)
// Each action type gets: icon helper, summary helper, full editor, list item

import type { NodeData } from '@treenity/core/core';
import { Checkbox } from '@treenity/react/components/ui/checkbox';
import { Input } from '@treenity/react/components/ui/input';
import { set, usePath } from '@treenity/react/hooks';
import { trpc } from '@treenity/react/trpc';
import {
  AlertTriangle,
  ArrowLeft,
  Code,
  Download,
  File,
  FileText,
  Forward,
  GitBranch,
  Globe,
  HelpCircle,
  History,
  MessageSquare,
  Repeat,
  RotateCcw,
  Search,
  Send,
  Settings2,
  Tag,
  Trash2,
  Upload,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import type {
  BroadcastAction,
  EmitTextAction,
  EvalAction,
  FileAction,
  ForwardAction,
  GetValueAction,
  IfElseAction,
  KeywordSelectAction,
  MessageAction,
  OnErrorAction,
  ParamsAction,
  QuestionAction,
  SelectLanguageAction,
  SetValueAction,
  TagAction,
} from '../types';
import { MenuEditor } from './menu-editor';
import { TStringInput, tstringPreview } from './tstring-input';

// ── Icon mapping ──

const ICONS: Record<string, ReactNode> = {
  'brahman.action.message': <MessageSquare className="h-4 w-4 text-blue-500" />,
  'brahman.action.question': <HelpCircle className="h-4 w-4 text-amber-500" />,
  'brahman.action.ifelse': <GitBranch className="h-4 w-4 text-purple-500" />,
  'brahman.action.page': <FileText className="h-4 w-4 text-green-500" />,
  'brahman.action.back': <ArrowLeft className="h-4 w-4 text-gray-500" />,
  'brahman.action.tag': <Tag className="h-4 w-4 text-orange-500" />,
  'brahman.action.broadcast': <Send className="h-4 w-4 text-red-500" />,
  'brahman.action.getvalue': <Download className="h-4 w-4 text-cyan-500" />,
  'brahman.action.setvalue': <Upload className="h-4 w-4 text-cyan-500" />,
  'brahman.action.params': <Settings2 className="h-4 w-4 text-gray-500" />,
  'brahman.action.file': <File className="h-4 w-4 text-indigo-500" />,
  'brahman.action.eval': <Code className="h-4 w-4 text-yellow-600" />,
  'brahman.action.remove': <Trash2 className="h-4 w-4 text-red-500" />,
  'brahman.action.emittext': <Repeat className="h-4 w-4 text-teal-500" />,
  'brahman.action.forward': <Forward className="h-4 w-4 text-blue-400" />,
  'brahman.action.resetsession': <RotateCcw className="h-4 w-4 text-rose-500" />,
  'brahman.action.resethistory': <History className="h-4 w-4 text-rose-400" />,
  'brahman.action.onerror': <AlertTriangle className="h-4 w-4 text-amber-600" />,
  'brahman.action.keywordselect': <Search className="h-4 w-4 text-emerald-500" />,
  'brahman.action.selectlang': <Globe className="h-4 w-4 text-sky-500" />,
};

export function actionIcon(type: string): ReactNode {
  return ICONS[type] ?? <Settings2 className="h-4 w-4 text-muted-foreground" />;
}

// ── Summary helpers for compact display ──

export function actionSummary(node: NodeData): string {
  const c = findActionComp(node) as any;
  if (!c) return '';

  switch (node.$type) {
    case 'brahman.action.message': return tstringPreview(c.text ?? {});
    case 'brahman.action.question': return `${tstringPreview(c.text ?? {}, 25)} -> ${c.saveTo || '?'}`;
    case 'brahman.action.ifelse': return c.condition || 'no condition';
    case 'brahman.action.page': return c.targetPage || 'no target';
    case 'brahman.action.back': return 'pop history';
    case 'brahman.action.tag': return `${c.tag} = ${c.value}`;
    case 'brahman.action.broadcast': return `to ${(c.userTags ?? []).join(', ') || 'all'}`;
    case 'brahman.action.getvalue': return `${c.path} -> ${c.saveTo}`;
    case 'brahman.action.setvalue': return `${c.value} -> ${c.saveTo}`;
    case 'brahman.action.params': return (c.names ?? []).join(', ') || 'no params';
    case 'brahman.action.file': return c.fileId || 'no file';
    case 'brahman.action.eval': return (c.value ?? '').slice(0, 40) || 'empty';
    case 'brahman.action.remove': return 'delete message';
    case 'brahman.action.emittext': return c.from || 'no text';
    case 'brahman.action.forward': return c.toFrom || 'current chat';
    case 'brahman.action.resetsession': return 'clear session';
    case 'brahman.action.resethistory': return 'clear history';
    case 'brahman.action.onerror': return c.error || 'any error';
    case 'brahman.action.keywordselect': return `${(c.elements ?? []).length} keywords`;
    case 'brahman.action.selectlang': return tstringPreview(c.text ?? {});
    default: return '';
  }
}

// Find the action component on a node (node itself if $type matches, then scan)
function findActionComp(node: NodeData): Record<string, unknown> | undefined {
  if (node.$type?.startsWith('brahman.action.')) return node;
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith('$')) continue;
    if (typeof v === 'object' && v && '$type' in v && typeof (v as any).$type === 'string'
      && (v as any).$type.startsWith('brahman.action.')) {
      return v as Record<string, unknown>;
    }
  }
}

// ── Shared field helpers ──

function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <label className="text-xs font-medium text-muted-foreground w-28 pt-2 shrink-0">{label}</label>
      <div className="flex-1">{children}</div>
    </div>
  );
}

function getLangs(node: NodeData): string[] {
  // Walk up to find bot config's langs
  // Default fallback
  return ['ru', 'en'];
}

// Generic component updater — debounced persist (500ms), instant UI via local state
function useActionComp(path: string) {
  const node = usePath(path);
  const [pending, setPending] = useState<Record<string, unknown>>({});
  const pendingRef = useRef<Record<string, unknown>>({});
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const nodeRef = useRef(node);
  nodeRef.current = node;

  const flush = useCallback(() => {
    clearTimeout(timerRef.current);
    const p = pendingRef.current;
    const n = nodeRef.current;
    if (!n || Object.keys(p).length === 0) return;
    pendingRef.current = {};
    setPending({});
    set({ ...n, ...p } as NodeData);
  }, []);

  // Flush on unmount (e.g. collapsing the action card)
  useEffect(() => () => { flush(); }, [flush]);

  // pending IS read in render → React Compiler keeps setPending calls
  const display = node && Object.keys(pending).length > 0
    ? { ...node, ...pending } as NodeData
    : node;
  const comp = display ? findActionComp(display) : undefined;

  function update(patch: Record<string, unknown>) {
    if (!node) return;
    const next = { ...pendingRef.current, ...patch };
    pendingRef.current = next;
    setPending(next);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, 2000);
  }

  return { node: display, comp, update, langs: getLangs(node!) };
}

// ── Full editors (react context) ──

export function MessageEditor({ value }: { value: NodeData }) {
  const { comp, update, langs } = useActionComp(value.$path);
  if (!comp) return null;
  const msg = comp as unknown as MessageAction;

  return (
    <div className="space-y-4 max-w-2xl">
      <FieldRow label="Text">
        <TStringInput value={msg.text} onChange={text => update({ text })} langs={langs} />
      </FieldRow>

      <FieldRow label="Disable links">
        <Checkbox
          checked={msg.disableLinks}
          onChange={e => update({ disableLinks: e.target.checked })}
        />
      </FieldRow>

      <MenuEditor
        menuType={msg.menuType}
        rows={msg.rows}
        langs={langs}
        onChangeType={menuType => update({ menuType })}
        onChangeRows={rows => update({ rows })}
      />
    </div>
  );
}

export function QuestionEditor({ value }: { value: NodeData }) {
  const { comp, update, langs } = useActionComp(value.$path);
  if (!comp) return null;
  const q = comp as unknown as QuestionAction;

  return (
    <div className="space-y-4 max-w-2xl">
      <FieldRow label="Prompt">
        <TStringInput value={q.text} onChange={text => update({ text })} langs={langs} />
      </FieldRow>

      <FieldRow label="Input type">
        <select className="h-8 text-sm border border-border rounded-md bg-background px-2"
          value={q.inputType} onChange={e => update({ inputType: e.target.value })}>
          <option value="text">Text</option>
          <option value="photo">Photo</option>
        </select>
      </FieldRow>

      <FieldRow label="Save to">
        <Input className="font-mono" placeholder="session.field"
          value={q.saveTo} onChange={e => update({ saveTo: e.target.value })} />
      </FieldRow>
    </div>
  );
}

export function IfElseEditor({ value }: { value: NodeData }) {
  const { comp, update } = useActionComp(value.$path);
  if (!comp) return null;
  const ie = comp as unknown as IfElseAction;

  return (
    <div className="space-y-4 max-w-2xl">
      <FieldRow label="Condition">
        <Input className="font-mono" placeholder="session.data.role === 'admin'"
          value={ie.condition} onChange={e => update({ condition: e.target.value })} />
      </FieldRow>

      <FieldRow label="Action if true">
        <Input className="font-mono" placeholder="/path/to/action"
          value={ie.actionIf} onChange={e => update({ actionIf: e.target.value })} />
      </FieldRow>

      <FieldRow label="Action if false">
        <Input className="font-mono" placeholder="/path/to/action"
          value={ie.actionElse} onChange={e => update({ actionElse: e.target.value })} />
      </FieldRow>

      <FieldRow label="Stop after">
        <Checkbox checked={ie.stopAfterAction}
          onChange={e => update({ stopAfterAction: e.target.checked })} />
      </FieldRow>
    </div>
  );
}

export function PageNavEditor({ value }: { value: NodeData }) {
  const { comp, update } = useActionComp(value.$path);
  const [dragOver, setDragOver] = useState(false);
  if (!comp) return null;

  return (
    <div className="space-y-4 max-w-2xl">
      <FieldRow label="Target page">
        <div
          className={`rounded-md transition-colors ${dragOver ? 'ring-1 ring-primary bg-primary/5' : ''}`}
          onDragOver={e => {
            if (e.dataTransfer.types.includes('application/treenity-path')) {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'link';
              setDragOver(true);
            }
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={async e => {
            const path = e.dataTransfer.getData('application/treenity-path');
            setDragOver(false);
            if (!path) return;
            e.preventDefault();
            const node = await trpc.get.query({ path });
            if (node?.$type === 'brahman.page') update({ targetPage: path });
          }}
        >
          <Input className="font-mono" placeholder="Drop a page here or type path"
            value={(comp as any).targetPage ?? ''}
            onChange={e => update({ targetPage: e.target.value })} />
        </div>
      </FieldRow>
    </div>
  );
}

export function BackEditor() {
  return (
    <div className="text-sm text-muted-foreground py-4">
      Pops the last page from navigation history. No configuration needed.
    </div>
  );
}

export function TagEditor({ value }: { value: NodeData }) {
  const { comp, update } = useActionComp(value.$path);
  if (!comp) return null;
  const t = comp as unknown as TagAction;

  return (
    <div className="space-y-4 max-w-2xl">
      <FieldRow label="Tag name">
        <Input placeholder="admin" value={t.tag} onChange={e => update({ tag: e.target.value })} />
      </FieldRow>
      <FieldRow label="Value">
        <Input className="font-mono" placeholder="true" value={t.value}
          onChange={e => update({ value: e.target.value })} />
      </FieldRow>
    </div>
  );
}

export function BroadcastEditor({ value }: { value: NodeData }) {
  const { comp, update } = useActionComp(value.$path);
  if (!comp) return null;
  const b = comp as unknown as BroadcastAction;

  return (
    <div className="space-y-4 max-w-2xl">
      <FieldRow label="User tags">
        <Input placeholder="premium, active" value={b.userTags.join(', ')}
          onChange={e => update({ userTags: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} />
      </FieldRow>
      <FieldRow label="Action path">
        <Input className="font-mono" placeholder="/path/to/action"
          value={b.action} onChange={e => update({ action: e.target.value })} />
      </FieldRow>
    </div>
  );
}

export function GetValueEditor({ value }: { value: NodeData }) {
  const { comp, update } = useActionComp(value.$path);
  if (!comp) return null;
  const g = comp as unknown as GetValueAction;

  return (
    <div className="space-y-4 max-w-2xl">
      <FieldRow label="Source path">
        <Input className="font-mono" placeholder="session.data.name"
          value={g.path} onChange={e => update({ path: e.target.value })} />
      </FieldRow>
      <FieldRow label="Save to">
        <Input className="font-mono" placeholder="result"
          value={g.saveTo} onChange={e => update({ saveTo: e.target.value })} />
      </FieldRow>
    </div>
  );
}

export function SetValueEditor({ value }: { value: NodeData }) {
  const { comp, update } = useActionComp(value.$path);
  if (!comp) return null;
  const s = comp as unknown as SetValueAction;

  return (
    <div className="space-y-4 max-w-2xl">
      <FieldRow label="Value">
        <Input className="font-mono" placeholder="'hello'" value={s.value}
          onChange={e => update({ value: e.target.value })} />
      </FieldRow>
      <FieldRow label="Save to">
        <Input className="font-mono" placeholder="session.data.greeting"
          value={s.saveTo} onChange={e => update({ saveTo: e.target.value })} />
      </FieldRow>
    </div>
  );
}

export function ParamsEditor({ value }: { value: NodeData }) {
  const { comp, update } = useActionComp(value.$path);
  if (!comp) return null;
  const p = comp as unknown as ParamsAction;

  return (
    <div className="space-y-4 max-w-2xl">
      <FieldRow label="Base64 decode">
        <Checkbox checked={p.base64} onChange={e => update({ base64: e.target.checked })} />
      </FieldRow>
      <FieldRow label="Split delimiter">
        <Input className="w-20 font-mono" value={p.split}
          onChange={e => update({ split: e.target.value })} />
      </FieldRow>
      <FieldRow label="Param names">
        <Input placeholder="id, name, email" value={p.names.join(', ')}
          onChange={e => update({ names: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} />
      </FieldRow>
    </div>
  );
}

export function FileEditor({ value }: { value: NodeData }) {
  const { comp, update } = useActionComp(value.$path);
  if (!comp) return null;
  const f = comp as unknown as FileAction;

  return (
    <div className="space-y-4 max-w-2xl">
      <FieldRow label="File path">
        <Input className="font-mono" placeholder="/files/image.png"
          value={f.fileId} onChange={e => update({ fileId: e.target.value })} />
      </FieldRow>
      <FieldRow label="Send as">
        <select className="h-8 text-sm border border-border rounded-md bg-background px-2"
          value={f.asType} onChange={e => update({ asType: e.target.value })}>
          <option value="">Auto-detect</option>
          <option value="photo">Photo</option>
          <option value="document">Document</option>
          <option value="video">Video</option>
          <option value="audio">Audio</option>
          <option value="voice">Voice</option>
        </select>
      </FieldRow>
    </div>
  );
}

// ── New action editors ──

export function EvalEditor({ value }: { value: NodeData }) {
  const { comp, update } = useActionComp(value.$path);
  if (!comp) return null;
  const ev = comp as unknown as EvalAction;

  return (
    <div className="space-y-4 max-w-2xl">
      <FieldRow label="JavaScript">
        <textarea
          className="w-full h-40 text-sm font-mono border border-border rounded-md bg-background p-2 resize-y"
          placeholder="// async function body&#10;await ctx.reply('Hello');"
          value={ev.value}
          onChange={e => update({ value: e.target.value })}
        />
      </FieldRow>
    </div>
  );
}

export function RemoveEditor() {
  return (
    <div className="text-sm text-muted-foreground py-4">
      Deletes the current message. No configuration needed.
    </div>
  );
}

export function EmitTextEditor({ value }: { value: NodeData }) {
  const { comp, update } = useActionComp(value.$path);
  if (!comp) return null;
  const et = comp as unknown as EmitTextAction;

  return (
    <div className="space-y-4 max-w-2xl">
      <FieldRow label="Text template">
        <Input className="font-mono" placeholder="/start or {data.command}"
          value={et.from} onChange={e => update({ from: e.target.value })} />
      </FieldRow>
    </div>
  );
}

export function ForwardEditor({ value }: { value: NodeData }) {
  const { comp, update } = useActionComp(value.$path);
  if (!comp) return null;
  const fw = comp as unknown as ForwardAction;

  return (
    <div className="space-y-4 max-w-2xl">
      <FieldRow label="Message ID from">
        <Input className="font-mono" placeholder="Empty = current message"
          value={fw.msgIdFrom} onChange={e => update({ msgIdFrom: e.target.value })} />
      </FieldRow>
      <FieldRow label="Forward to">
        <Input className="font-mono" placeholder="Chat/user ID or {data.to}"
          value={fw.toFrom} onChange={e => update({ toFrom: e.target.value })} />
      </FieldRow>
    </div>
  );
}

export function ResetSessionEditor() {
  return (
    <div className="text-sm text-muted-foreground py-4">
      Clears all session data. History is preserved. No configuration needed.
    </div>
  );
}

export function ResetHistoryEditor() {
  return (
    <div className="text-sm text-muted-foreground py-4">
      Clears navigation history. No configuration needed.
    </div>
  );
}

export function OnErrorEditor({ value }: { value: NodeData }) {
  const { comp, update } = useActionComp(value.$path);
  if (!comp) return null;
  const oe = comp as unknown as OnErrorAction;

  return (
    <div className="space-y-4 max-w-2xl">
      <FieldRow label="Error match">
        <Input placeholder="Substring to match in error message (empty = any)"
          value={oe.error} onChange={e => update({ error: e.target.value })} />
      </FieldRow>
      <FieldRow label="Action path">
        <Input className="font-mono" placeholder="/path/to/action"
          value={oe.action} onChange={e => update({ action: e.target.value })} />
      </FieldRow>
    </div>
  );
}

export function KeywordSelectEditor({ value }: { value: NodeData }) {
  const { comp, update } = useActionComp(value.$path);
  if (!comp) return null;
  const ks = comp as unknown as KeywordSelectAction;

  function updateElement(idx: number, patch: Partial<{ keywords: string[]; message: string }>) {
    const elements = [...(ks.elements ?? [])];
    elements[idx] = { ...elements[idx], ...patch };
    update({ elements });
  }

  function addElement() {
    update({ elements: [...(ks.elements ?? []), { keywords: [], message: '' }] });
  }

  function removeElement(idx: number) {
    const elements = [...(ks.elements ?? [])];
    elements.splice(idx, 1);
    update({ elements });
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <FieldRow label="Source text">
        <Input className="font-mono" placeholder="{data.text} or empty for message text"
          value={ks.textFrom} onChange={e => update({ textFrom: e.target.value })} />
      </FieldRow>

      <div className="space-y-2">
        <label className="text-xs font-medium text-muted-foreground">Keyword entries</label>
        {(ks.elements ?? []).map((el, i) => (
          <div key={i} className="flex gap-2 items-start p-2 border border-border rounded-md">
            <div className="flex-1 space-y-1">
              <Input placeholder="keyword1, keyword2" value={el.keywords.join(', ')}
                onChange={e => updateElement(i, {
                  keywords: e.target.value.split(',').map(s => s.trim()).filter(Boolean),
                })} />
              <Input className="font-mono" placeholder="/command or reply text"
                value={el.message} onChange={e => updateElement(i, { message: e.target.value })} />
            </div>
            <button onClick={() => removeElement(i)}
              className="text-muted-foreground hover:text-destructive p-1">
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
        <button onClick={addElement}
          className="text-xs text-primary hover:underline">
          + Add keyword entry
        </button>
      </div>
    </div>
  );
}

export function SelectLanguageEditor({ value }: { value: NodeData }) {
  const { comp, update, langs } = useActionComp(value.$path);
  if (!comp) return null;
  const sl = comp as unknown as SelectLanguageAction;

  return (
    <div className="space-y-4 max-w-2xl">
      <FieldRow label="Prompt text">
        <TStringInput value={sl.text} onChange={text => update({ text })} langs={langs} />
      </FieldRow>
    </div>
  );
}

// ── Compact list items (react:list context) ──

export function ActionListItem({ value }: { value: NodeData }) {
  return (
    <div className="flex items-center gap-2 py-1 flex-1">
      {actionIcon(value.$type)}
      <span className="text-xs font-medium text-muted-foreground">
        {value.$type.split('.').at(-1)}
      </span>
      <span className="text-sm truncate">{actionSummary(value)}</span>
    </div>
  );
}
