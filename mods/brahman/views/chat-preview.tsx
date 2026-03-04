// Chat preview — Telegram-style visualization of page actions
// Registered as react:chat for brahman.page

import type { NodeData } from '@treenity/core/core';
import { useChildren, usePath } from '@treenity/react/hooks';
import { Camera, File, Mic, Video } from 'lucide-react';
import type { MenuRow, MenuType, TString } from '../types';
import { actionIcon, actionSummary } from './action-cards';
import { tstringPreview } from './tstring-input';

// ── Helpers (browser-safe, no grammy import) ──

function tstr(ts: TString | undefined): string {
  if (!ts) return '';
  return ts.ru || ts.en || Object.values(ts).find(v => v) || '';
}

// ── Telegram-style HTML rendering (safe subset) ──

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
    const children = Array.from(el.childNodes).map(domToReact);
    return <a key={key} href={href} target="_blank" rel="noopener noreferrer" className="text-[#5b9bd5] underline">{children}</a>;
  }

  const cls = TG_TAGS[tag];
  if (cls) {
    const children = Array.from(el.childNodes).map(domToReact);
    return <span key={key} className={cls}>{children}</span>;
  }

  // Unknown tag — render children as text only
  return Array.from(el.childNodes).map(domToReact);
}

function TgHtml({ text }: { text: string }) {
  if (!/<[a-z][\s>]/i.test(text)) return <>{text}</>;

  const doc = new DOMParser().parseFromString(text, 'text/html');
  return <>{Array.from(doc.body.childNodes).map(domToReact)}</>;
}

function getComp(node: NodeData): Record<string, unknown> {
  if (node.$type?.startsWith('brahman.action.')) return node;
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith('$')) continue;
    if (typeof v === 'object' && v && '$type' in v) return v as Record<string, unknown>;
  }
  return node;
}

// ── Chat elements ──

function BotBubble({ children, first }: { children: React.ReactNode; first?: boolean }) {
  return (
    <div className="flex flex-col items-start max-w-[85%]">
      {first && <span className="text-[11px] font-semibold text-[#5b9bd5] mb-0.5 ml-1">Bot</span>}
      <div className="bg-[#182533] text-[#e1e3e6] text-sm rounded-lg rounded-tl-sm px-3 py-2 whitespace-pre-wrap break-words">
        {children}
      </div>
    </div>
  );
}

function InlineButtons({ rows, menuType }: { rows: MenuRow[]; menuType: MenuType }) {
  if (!rows?.length || menuType === 'none' || menuType === 'remove') return null;
  const isReply = menuType === 'keyboard' || menuType === 'force_reply';

  return (
    <div className={`flex flex-col gap-0.5 ${isReply ? 'w-full mt-2' : 'max-w-[85%] mt-0.5'}`}>
      {rows.map((row, ri) => (
        <div key={ri} className="flex gap-0.5">
          {row.buttons.map(btn => {
            const text = tstringPreview(btn.title, 24) || '...';
            return (
              <div
                key={btn.id}
                className={`flex-1 text-center text-xs py-1.5 px-2 rounded truncate
                  ${isReply
                    ? 'bg-[#1c2733] text-[#e1e3e6] border border-[#2b3945]'
                    : 'bg-[#2b5278] text-[#e1e3e6]'
                  }`}
              >
                {btn.url ? `🔗 ${text}` : text}
              </div>
            );
          })}
        </div>
      ))}
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

function SystemPill({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-center">
      <div className="flex items-center gap-1.5 text-[11px] text-[#6c7883] bg-[#131c26] rounded-full px-3 py-1">
        {children}
      </div>
    </div>
  );
}

const FILE_ICONS: Record<string, React.ReactNode> = {
  photo: <Camera className="h-8 w-8" />,
  video: <Video className="h-8 w-8" />,
  audio: <Mic className="h-8 w-8" />,
  voice: <Mic className="h-8 w-8" />,
};

// ── Action renderers ──

function renderAction(node: NodeData, index: number, isFirstBubble: boolean): React.ReactNode {
  const c = getComp(node);
  const type = node.$type;

  switch (type) {
    case 'brahman.action.message': {
      const text = tstr(c.text as TString) || '(empty message)';
      const menuType = (c.menuType as MenuType) ?? 'none';
      const rows = (c.rows as MenuRow[]) ?? [];
      return (
        <div key={node.$path} className="flex flex-col items-start gap-0">
          <BotBubble first={isFirstBubble}><TgHtml text={text} /></BotBubble>
          <InlineButtons rows={rows} menuType={menuType} />
        </div>
      );
    }

    case 'brahman.action.question': {
      const text = tstr(c.text as TString) || '(question)';
      const inputType = (c.inputType as string) ?? 'text';
      return (
        <div key={node.$path} className="space-y-1.5">
          <BotBubble first={isFirstBubble}><TgHtml text={text} /></BotBubble>
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
      const asType = (c.asType as string) || 'document';
      const icon = FILE_ICONS[asType] ?? <File className="h-8 w-8" />;
      return (
        <div key={node.$path}>
          <BotBubble first={isFirstBubble}>
            <div className="flex flex-col items-center gap-1 py-2 text-[#6c7883]">
              {icon}
              <span className="text-xs">{asType}</span>
            </div>
          </BotBubble>
        </div>
      );
    }

    case 'brahman.action.selectlang': {
      const text = tstr(c.text as TString) || 'Choose language';
      return (
        <div key={node.$path} className="flex flex-col items-start gap-0.5">
          <BotBubble first={isFirstBubble}><TgHtml text={text} /></BotBubble>
          <div className="flex gap-0.5 max-w-[85%]">
            <div className="flex-1 text-center text-xs py-1.5 px-2 rounded bg-[#2b5278] text-[#e1e3e6]">🇷🇺 RU</div>
            <div className="flex-1 text-center text-xs py-1.5 px-2 rounded bg-[#2b5278] text-[#e1e3e6]">🇬🇧 EN</div>
          </div>
        </div>
      );
    }

    // All other actions → system pills
    default: {
      const summary = actionSummary(node);
      const label = type.split('.').at(-1) ?? type;
      return (
        <SystemPill key={node.$path}>
          {actionIcon(type)}
          <span>{label}{summary ? `: ${summary}` : ''}</span>
        </SystemPill>
      );
    }
  }
}

// ── Main component ──

export function PageChatPreview({ value }: { value: NodeData }) {
  const node = usePath(value.$path);
  const actionsPath = value.$path + '/_actions';
  const children = useChildren(actionsPath, { watch: true, watchNew: true });

  const positions: string[] = (node?.positions as string[]) ?? [];
  const tracked = new Set(positions);
  const sorted = [
    ...positions.map(p => children.find(c => c.$path === p)).filter((c): c is NodeData => !!c),
    ...children.filter(c => !tracked.has(c.$path) && c.$type?.startsWith('brahman.action.')),
  ];

  let hadBotBubble = false;

  return (
    <div className="bg-[#0e1621] rounded-xl p-4 space-y-2.5 min-h-[200px] max-w-md mx-auto">
      {/* Command header */}
      {typeof node?.command === 'string' && node.command && (
        <div className="flex justify-center mb-2">
          <span className="text-[11px] text-[#6c7883] bg-[#131c26] rounded-full px-3 py-1 font-mono">
            {node.command}
          </span>
        </div>
      )}

      {sorted.length === 0 && (
        <div className="text-[#6c7883] text-xs text-center py-8">No actions</div>
      )}

      {sorted.map((child, i) => {
        const isBubbleType = ['brahman.action.message', 'brahman.action.question',
          'brahman.action.file', 'brahman.action.selectlang'].includes(child.$type);
        const isFirstBubble = isBubbleType && !hadBotBubble;
        if (isBubbleType) hadBotBubble = true;

        return renderAction(child, i, isFirstBubble);
      })}

      {/* Input bar mockup */}
      <div className="flex items-center gap-2 mt-4 pt-3 border-t border-[#1c2733]">
        <div className="flex-1 bg-[#1c2733] rounded-full px-3 py-1.5 text-xs text-[#6c7883]">
          Message...
        </div>
      </div>
    </div>
  );
}
