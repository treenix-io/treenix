import { useNavigate } from '@treenity/react/hooks';
import { minimd } from '@treenity/react/lib/minimd';
import { cn } from '@treenity/react/lib/utils';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

// ── Structured log parser ──

type LogBlock =
  | { type: 'text'; content: string }
  | { type: 'tool'; name: string; input: string; time?: string }
  | { type: 'thinking'; content: string; time?: string }
  | { type: 'result'; content: string; time?: string }
  | { type: 'interrupted'; time?: string };

const BLOCK_RE = /\n?\[(tool|thinking|result|interrupted)(?: (\d\d:\d\d:\d\d))?\](?: ([^\n]*))?\n?/;

function parseLog(raw: unknown): LogBlock[] {
  if (typeof raw !== 'string' || !raw) return [];
  const blocks: LogBlock[] = [];
  let rest = raw;

  while (rest) {
    const m = BLOCK_RE.exec(rest);
    if (!m) {
      if (rest.trim()) blocks.push({ type: 'text', content: rest.trim() });
      break;
    }

    const before = rest.slice(0, m.index).trim();
    if (before) blocks.push({ type: 'text', content: before });

    const tag = m[1];
    const time = m[2] || undefined; // HH:mm:ss or undefined
    const inline = m[3] ?? '';
    rest = rest.slice(m.index + m[0].length);

    if (tag === 'tool') {
      // Consume everything until next block marker (JSON input is multi-line)
      const nextBlock = BLOCK_RE.exec(rest);
      const input = nextBlock ? rest.slice(0, nextBlock.index) : rest;
      rest = nextBlock ? rest.slice(nextBlock.index) : '';
      blocks.push({ type: 'tool', name: inline, input: input.trim(), time });
    } else if (tag === 'thinking') {
      const nextBlock = BLOCK_RE.exec(rest);
      const content = nextBlock ? rest.slice(0, nextBlock.index) : rest;
      rest = nextBlock ? rest.slice(nextBlock.index) : '';
      blocks.push({ type: 'thinking', content: content.trim(), time });
    } else if (tag === 'result') {
      const nextBlock = BLOCK_RE.exec(rest);
      const content = inline
        ? (nextBlock ? inline + '\n' + rest.slice(0, nextBlock.index) : inline + '\n' + rest)
        : (nextBlock ? rest.slice(0, nextBlock.index) : rest);
      rest = nextBlock ? rest.slice(nextBlock.index) : '';
      blocks.push({ type: 'result', content: content.trim(), time });
    } else if (tag === 'interrupted') {
      blocks.push({ type: 'interrupted', time });
    }
  }
  return blocks;
}

// ── Linkified text (clickable /paths) ──

const PATH_RE = /(?:^|\s)(\/[\w./-]+)/g;

function Linkified({ text }: { text: string }) {
  const navigate = useNavigate();
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(PATH_RE)) {
    const path = match[1];
    const start = match.index + match[0].indexOf(path);
    if (start > lastIndex) parts.push(text.slice(lastIndex, start));
    parts.push(
      <button
        key={`${start}-${path}`}
        onClick={() => navigate(path)}
        className="text-violet-400 hover:text-violet-300 hover:underline transition-colors"
      >
        {path}
      </button>
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return <>{parts.length ? parts : text}</>;
}

// ── Code syntax highlighting ──
// XXX: BAD one, use general lib
const TOKEN = new RegExp([
  '(\\/\\/[^\\n]*)',                                            // 0: comments
  '(\'(?:[^\'\\\\]|\\\\.)*\'|"(?:[^"\\\\]|\\\\.)*"|`(?:[^`\\\\]|\\\\.)*`)', // 1: strings
  '\\b(import|export|from|const|let|var|type|interface|class|function|async|await|return|if|else|for|of|in|while|new|throw|try|catch|finally|default|extends|implements|as|typeof|instanceof)\\b', // 2: keywords
  '\\b(string|number|boolean|void|null|undefined|true|false|any|unknown|never|Promise|Record|Map|Set|Array)\\b', // 3: types
  '(\\b\\d+(?:\\.\\d+)?\\b)',                                  // 4: numbers
].join('|'), 'g');

const TOKEN_CLS = ['text-zinc-600', 'text-emerald-400', 'text-violet-400', 'text-sky-400', 'text-amber-400'];

function colorize(code: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of code.matchAll(TOKEN)) {
    if (m.index! > last) nodes.push(<span key={k++} className="text-zinc-300">{code.slice(last, m.index!)}</span>);
    const gi = m.slice(1).findIndex(g => g !== undefined);
    nodes.push(<span key={k++} className={TOKEN_CLS[gi] || 'text-zinc-300'}>{m[0]}</span>);
    last = m.index! + m[0].length;
  }
  if (last < code.length) nodes.push(<span key={k++} className="text-zinc-300">{code.slice(last)}</span>);
  return nodes;
}

function CodeResult({ text }: { text: string }) {
  const rendered = useMemo(() => {
    return text.split('\n').map((line, i) => {
      const ln = line.match(/^(\s*\d+→)(.*)/);
      return (
        <div key={i}>
          {ln ? <><span className="text-zinc-700 select-none">{ln[1]}</span>{colorize(ln[2])}</> : colorize(line)}
        </div>
      );
    });
  }, [text]);

  return <pre className="font-mono text-[11px] leading-snug">{rendered}</pre>;
}

// ── Markdown content ──
// XXX: rewrite
function isJson(s: string): boolean {
  const t = s.trim();
  return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'));
}

// ── JSON tree viewer ──

function JsonValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null) return <span className="text-zinc-600">null</span>;
  if (value === undefined) return <span className="text-zinc-600">undefined</span>;
  if (typeof value === 'boolean') return <span className="text-amber-400">{String(value)}</span>;
  if (typeof value === 'number') return <span className="text-sky-400">{value}</span>;
  if (typeof value === 'string') {
    if (value.length > 200) {
      return <CollapsibleJson label={`"${value.slice(0, 60)}…"  (${value.length})`} className="text-emerald-400">{value}</CollapsibleJson>;
    }
    return <span className="text-emerald-400">"{value}"</span>;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-zinc-500">[]</span>;
    return (
      <CollapsibleJson label={`Array(${value.length})`} className="text-zinc-400" defaultOpen={depth < 2}>
        <div className="pl-3 border-l border-zinc-800/60">
          {value.map((item, i) => (
            <div key={i} className="flex gap-1">
              <span className="text-zinc-600 shrink-0 select-none">{i}:</span>
              <JsonValue value={item} depth={depth + 1} />
            </div>
          ))}
        </div>
      </CollapsibleJson>
    );
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return <span className="text-zinc-500">{'{}'}</span>;
    return (
      <CollapsibleJson label={`{${entries.length}}`} className="text-zinc-400" defaultOpen={depth < 2}>
        <div className="pl-3 border-l border-zinc-800/60">
          {entries.map(([k, v]) => (
            <div key={k} className="flex gap-1">
              <span className="text-violet-400/80 shrink-0">{k}:</span>
              <JsonValue value={v} depth={depth + 1} />
            </div>
          ))}
        </div>
      </CollapsibleJson>
    );
  }

  return <span className="text-zinc-400">{String(value)}</span>;
}

function CollapsibleJson({ label, className, defaultOpen = false, children }: {
  label: string; className?: string; defaultOpen?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <span>
      <button onClick={() => setOpen(!open)} className={cn('hover:underline', className)}>
        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"
          className={cn('inline mr-0.5 transition-transform duration-100', open && 'rotate-90')}
        ><path d="M9 18l6-6-6-6" /></svg>
        {label}
      </button>
      {open && <div className="mt-0.5">{children}</div>}
    </span>
  );
}

function JsonTree({ text, className }: { text: string; className?: string }) {
  const parsed = useMemo(() => {
    try { return JSON.parse(text); }
    catch { return null; }
  }, [text]);

  if (parsed === null) return null;
  return (
    <div className={cn('font-mono text-[11px] leading-relaxed', className)}>
      <JsonValue value={parsed} />
    </div>
  );
}

export function Md({ text, className }: { text: string; className?: string }) {
  const json = isJson(text);
  const html = useMemo(() => json ? '' : minimd(text), [text, json]);

  if (json) return <JsonTree text={text} className={className} />;
  return <div className={cn('minimd', className)} dangerouslySetInnerHTML={{ __html: html }} />;
}

// ── Collapsible block ──
// forceOpen syncs state on change but allows individual toggle after

function truncate(s: string, max = 80): string {
  const line = s.split('\n')[0];
  return line.length > max ? line.slice(0, max) + '...' : line;
}

// Height threshold: below this the label stays inline (left), above it goes on top
const LABEL_TOP_THRESHOLD = 120;

export function CollapsibleBlock({ label, labelClass, preview, children, wrap, forceOpen, defaultOpen }: {
  label: React.ReactNode;
  labelClass?: string;
  preview?: string;
  children: React.ReactNode;
  wrap: boolean;
  forceOpen?: boolean;
  defaultOpen?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen ?? false);
  const [labelTop, setLabelTop] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  // Sync with parent fold/unfold — but user can override after
  useEffect(() => {
    if (forceOpen !== undefined) setIsOpen(forceOpen);
  }, [forceOpen]);

  // One-time measurement after content renders — decide label position
  useLayoutEffect(() => {
    if (isOpen && contentRef.current) {
      setLabelTop(contentRef.current.scrollHeight > LABEL_TOP_THRESHOLD);
    }
  }, [isOpen]);

  return (
    <div className={cn(isOpen && !labelTop && 'flex items-start')}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          'flex items-center gap-1.5 px-2 py-1 text-left text-xs font-medium transition-colors rounded shrink-0',
          isOpen && !labelTop && 'w-auto',
          !isOpen && 'w-full',
          labelClass
        )}
      >
        <svg
          width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          className={cn('shrink-0 transition-transform duration-150', isOpen && 'rotate-90')}
        >
          <path d="M9 18l6-6-6-6" />
        </svg>
        {label}
        {!isOpen && preview && (
          <span className="text-zinc-600 font-mono text-[10px] truncate ml-1 flex-1">{preview}</span>
        )}
      </button>
      {isOpen && (
        <div
          ref={contentRef}
          className={cn(
            'py-1 text-xs leading-relaxed max-h-[40vh] overflow-y-auto flex-1 min-w-0',
            labelTop ? 'pl-4 pr-1' : 'pl-2 pr-1',
            wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre overflow-x-auto'
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}

// ── Log renderer ──

export function LogRenderer({ text, className }: { text: string; className?: string }) {
  const blocks = useMemo(() => parseLog(text), [text]);
  const [wrap, setWrap] = useState(true);
  const [expandAll, setExpandAll] = useState<boolean | undefined>(undefined);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new blocks arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [blocks.length]);

  if (!blocks.length) return <pre className={className}>No output yet</pre>;

  const hasCollapsible = blocks.some(b => b.type === 'tool' || b.type === 'result' || b.type === 'thinking');

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <div className="flex justify-end gap-1 px-1">
        {hasCollapsible && (
          <button
            onClick={() => setExpandAll(prev => !prev)}
            className="text-[11px] text-zinc-600 hover:text-zinc-400 transition-colors font-mono px-1.5 py-0.5 rounded border border-zinc-800/60 hover:border-zinc-700"
          >
            {expandAll ? 'fold' : 'unfold'}
          </button>
        )}
        <button
          onClick={() => setWrap(!wrap)}
          className="text-[11px] text-zinc-600 hover:text-zinc-400 transition-colors font-mono px-1.5 py-0.5 rounded border border-zinc-800/60 hover:border-zinc-700"
          title={wrap ? 'Unwrap lines' : 'Wrap lines'}
        >
          {wrap ? 'unwrap' : 'wrap'}
        </button>
      </div>
      {blocks.map((block, i) => {
        const isRecent = i >= blocks.length - 2;

        switch (block.type) {
          case 'text':
            return (
              <Md key={i} text={block.content} className="text-zinc-300 text-sm" />
            );

          case 'tool':
            return (
              <CollapsibleBlock
                key={i}
                wrap={wrap}
                forceOpen={expandAll}
                defaultOpen={isRecent}
                label={<span className="text-sky-400 font-mono truncate">{block.name}{block.time && <span className="text-sky-400/40 ml-2 text-[10px]">{block.time}</span>}</span>}
                labelClass="bg-sky-500/8 hover:bg-sky-500/12 text-sky-400/80"
                preview={truncate(block.input)}
              >
                {isJson(block.input)
                  ? <JsonTree text={block.input} className="text-zinc-500" />
                  : <pre className="text-zinc-500 font-mono text-[11px]">{block.input}</pre>
                }
              </CollapsibleBlock>
            );

          case 'result':
            return (
              <CollapsibleBlock
                key={i}
                wrap={wrap}
                forceOpen={expandAll}
                defaultOpen={isRecent}
                label={<span className="text-emerald-400">result{block.time && <span className="text-emerald-400/40 ml-2 text-[10px]">{block.time}</span>}</span>}
                labelClass="bg-emerald-500/8 hover:bg-emerald-500/12 text-emerald-400/80"
                preview={truncate(block.content)}
              >
                {isJson(block.content)
                  ? <JsonTree text={block.content} className="text-zinc-500" />
                  : /^\s*\d+→/.test(block.content)
                    ? <CodeResult text={block.content} />
                    : <Md text={block.content} className="text-zinc-400 text-xs" />
                }
              </CollapsibleBlock>
            );

          case 'thinking':
            return (
              <CollapsibleBlock
                key={i}
                wrap={wrap}
                forceOpen={expandAll}
                defaultOpen={isRecent}
                label={<span className="text-amber-400/70 italic">thinking{block.time && <span className="text-amber-400/40 ml-2 text-[10px] not-italic">{block.time}</span>}</span>}
                labelClass="bg-amber-500/5 hover:bg-amber-500/10 text-amber-400/60"
                preview={truncate(block.content)}
              >
                <Md text={block.content} className="text-zinc-500 italic text-xs" />
              </CollapsibleBlock>
            );

          case 'interrupted':
            return (
              <div key={i} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20">
                <span className="w-2 h-2 rounded-sm bg-red-400" />
                <span className="text-[11px] text-red-400 font-medium">Interrupted</span>
                {block.time && <span className="text-[10px] text-red-400/40 ml-auto font-mono">{block.time}</span>}
              </div>
            );
        }
      })}
      <div ref={bottomRef} />
    </div>
  );
}
