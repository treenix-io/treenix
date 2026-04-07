// Lightweight JSON editor — no deps. Textarea + highlighted overlay.
// Features: syntax highlighting, auto-close quotes/brackets, auto-commas, format, virtual folding.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './editor-ui.css';

type Props = {
  value: string;
  onChange: (text: string) => void;
};

// --- Syntax highlight ---

function highlight(src: string): string {
  return src.replace(
    /("(?:[^"\\]|\\.)*")\s*:|("(?:[^"\\]|\\.)*")|(\b(?:true|false|null)\b)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (match, key, str, lit, num) => {
      if (key) return `<span class="jk">${esc(key)}</span>:`;
      if (str) return `<span class="js">${esc(str)}</span>`;
      if (lit) return `<span class="jl">${esc(lit)}</span>`;
      if (num) return `<span class="jn">${esc(num)}</span>`;
      return esc(match);
    },
  );
}

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- Auto-pairs ---

const PAIRS: Record<string, string> = { '"': '"', '{': '}', '[': ']' };
const CLOSERS = new Set(['"', '}', ']']);

function handleKeyDown(
  e: React.KeyboardEvent<HTMLTextAreaElement>,
  onChange: (text: string) => void,
) {
  const ta = e.currentTarget;
  const { selectionStart: s, selectionEnd: end, value } = ta;

  if (e.key === 'Tab') {
    e.preventDefault();
    insert(ta, '  ', onChange);
    return;
  }

  if (PAIRS[e.key] && s === end) {
    e.preventDefault();
    insert(ta, e.key + PAIRS[e.key], onChange, -1);
    return;
  }

  if (CLOSERS.has(e.key) && value[s] === e.key && s === end) {
    e.preventDefault();
    ta.selectionStart = ta.selectionEnd = s + 1;
    return;
  }

  if (e.key === 'Backspace' && s === end && s > 0) {
    const before = value[s - 1];
    const after = value[s];
    if (PAIRS[before] === after) {
      e.preventDefault();
      ta.value = value.slice(0, s - 1) + value.slice(s + 1);
      ta.selectionStart = ta.selectionEnd = s - 1;
      onChange(ta.value);
      return;
    }
  }

  if (e.key === 'Enter') {
    e.preventDefault();
    const before = value.slice(0, s);
    const after = value.slice(end);
    const lineStart = before.lastIndexOf('\n') + 1;
    const indent = before.slice(lineStart).match(/^\s*/)?.[0] ?? '';
    const charBefore = before.trimEnd().slice(-1);
    const charAfter = after.trimStart()[0];

    if ((charBefore === '{' && charAfter === '}') || (charBefore === '[' && charAfter === ']')) {
      const inner = '\n' + indent + '  ';
      const close = '\n' + indent;
      ta.value = before + inner + close + after;
      ta.selectionStart = ta.selectionEnd = s + inner.length;
      onChange(ta.value);
      return;
    }

    let comma = '';
    if (needsComma(charBefore, charAfter)) comma = ',';

    const deeper = (charBefore === '{' || charBefore === '[') ? indent + '  ' : indent;
    const nl = comma + '\n' + deeper;
    ta.value = before + nl + after;
    ta.selectionStart = ta.selectionEnd = s + nl.length;
    onChange(ta.value);
  }
}

function needsComma(charBefore: string, charAfter: string): boolean {
  if (!charBefore) return false;
  if (charBefore === ',' || charBefore === '{' || charBefore === '[' || charBefore === ':') return false;
  if (!/["\d}\]eul]/.test(charBefore)) return false;
  if (charAfter === ',') return false;
  return true;
}

// --- Validation ---

function validate(src: string): string | null {
  if (!src.trim()) return null;
  try { JSON.parse(src); return null; } catch (e) {
    const msg = (e instanceof SyntaxError) ? e.message : 'Invalid JSON';
    const posMatch = msg.match(/position\s+(\d+)/);
    if (posMatch) {
      const pos = Number(posMatch[1]);
      const line = src.slice(0, pos).split('\n').length;
      return `Line ${line}: ${msg.replace(/^JSON\.parse:\s*/, '')}`;
    }
    return msg.replace(/^JSON\.parse:\s*/, '');
  }
}

// --- Auto-fix ---

function autofix(src: string): string {
  let fixed = src.replace(/,(\s*[}\]])/g, '$1');
  fixed = fixed.replace(/(["'\d}\]eul])([ \t]*\n)([ \t]*["{\[\dtfn-])/g, '$1,$2$3');
  return fixed;
}

function insert(ta: HTMLTextAreaElement, text: string, onChange: (t: string) => void, cursorOffset = 0) {
  const { selectionStart: s, selectionEnd: end, value } = ta;
  ta.value = value.slice(0, s) + text + value.slice(end);
  ta.selectionStart = ta.selectionEnd = s + text.length + cursorOffset;
  onChange(ta.value);
}

// --- Folding (virtual — textarea text is never modified) ---

function findMatchingBracket(text: string, pos: number): number {
  const open = text[pos];
  const close = open === '{' ? '}' : ']';
  let depth = 1;
  let inStr = false;

  for (let i = pos + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && inStr) { i++; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// Find which line a char offset falls on
function lineAt(text: string, pos: number): number {
  let line = 0;
  for (let i = 0; i < pos; i++) if (text[i] === '\n') line++;
  return line;
}

// Compute fold ranges: for each fold start line → end line (inclusive)
function computeFoldRanges(
  value: string,
  foldedStarts: Set<number>,
): Map<number, number> {
  const ranges = new Map<number, number>();
  const lines = value.split('\n');

  for (const startLine of foldedStarts) {
    if (startLine >= lines.length) continue;
    const line = lines[startLine];
    const trimmed = line.trimEnd();
    const last = trimmed[trimmed.length - 1];
    if (last !== '{' && last !== '[') continue;

    // Find char position of the bracket
    let charPos = 0;
    for (let i = 0; i < startLine; i++) charPos += lines[i].length + 1;
    charPos += line.lastIndexOf(last);

    const matchPos = findMatchingBracket(value, charPos);
    if (matchPos === -1) continue;

    const endLine = lineAt(value, matchPos);
    if (endLine > startLine) ranges.set(startLine, endLine);
  }

  return ranges;
}

// Count items inside a bracket block (for the summary label)
function countItems(value: string, startLine: number): number {
  const lines = value.split('\n');
  const line = lines[startLine];
  const trimmed = line.trimEnd();
  const bracket = trimmed[trimmed.length - 1];

  let charPos = 0;
  for (let i = 0; i < startLine; i++) charPos += lines[i].length + 1;
  charPos += line.lastIndexOf(bracket);

  const matchPos = findMatchingBracket(value, charPos);
  if (matchPos === -1) return 0;

  const block = value.slice(charPos, matchPos + 1);
  try {
    const parsed = JSON.parse(block);
    return Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length;
  } catch { return 0; }
}

// --- Component ---

export function JsonEditor({ value, onChange }: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Virtual folds — set of start line indices
  const [foldedStarts, setFoldedStarts] = useState<Set<number>>(() => new Set());

  // Reset folds when value identity changes (node switch)
  const prevValueRef = useRef(value);
  if (value !== prevValueRef.current) {
    prevValueRef.current = value;
    if (foldedStarts.size > 0) setFoldedStarts(new Set());
  }

  const syncScroll = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    if (preRef.current) preRef.current.scrollTop = ta.scrollTop;
  }, []);

  const error = useMemo(() => validate(value), [value]);

  const format = useCallback(() => {
    let src = value;
    try { JSON.parse(src); } catch { src = autofix(src); }
    try {
      onChangeRef.current(JSON.stringify(JSON.parse(src), null, 2));
      setFoldedStarts(new Set());
    } catch { /* broken */ }
  }, [value]);

  const lines = useMemo(() => value.split('\n'), [value]);

  // Compute fold ranges from current foldedStarts
  const foldRanges = useMemo(
    () => computeFoldRanges(value, foldedStarts),
    [value, foldedStarts],
  );

  // Build hidden line set (all lines inside a fold, excluding the start line)
  const hiddenLines = useMemo(() => {
    const hidden = new Set<number>();
    for (const [start, end] of foldRanges) {
      for (let i = start + 1; i <= end; i++) hidden.add(i);
    }
    return hidden;
  }, [foldRanges]);

  // Per-line fold info for the gutter
  const getFoldInfo = useCallback((lineIdx: number): 'expanded' | 'collapsed' | null => {
    if (foldRanges.has(lineIdx)) return 'collapsed'; // currently folded
    const trimmed = lines[lineIdx]?.trimEnd();
    const last = trimmed?.[trimmed.length - 1];
    if (last === '{' || last === '[') return 'expanded'; // can fold
    return null;
  }, [lines, foldRanges]);

  const handleFold = useCallback((lineIdx: number) => {
    setFoldedStarts(prev => { const next = new Set(prev); next.add(lineIdx); return next; });
  }, []);

  const handleUnfold = useCallback((lineIdx: number) => {
    setFoldedStarts(prev => { const next = new Set(prev); next.delete(lineIdx); return next; });
  }, []);

  useEffect(() => {
    if (taRef.current && taRef.current.value !== value) {
      taRef.current.value = value;
    }
  }, [value]);

  return (
    <div className="relative font-mono text-xs leading-5">
      <div className="sticky top-0 z-30 rounded-t border border-b-0 border-border bg-secondary/80 backdrop-blur-sm px-2 py-1 text-[11px]">
        {error ? (
          <div className="text-destructive break-words">{error}</div>
        ) : (
          <button
            type="button"
            onClick={format}
            className="px-2.5 py-1 rounded border border-border bg-background text-muted-foreground hover:bg-secondary hover:text-foreground cursor-pointer transition-colors"
          >
            Format
          </button>
        )}
      </div>
      <div className="relative min-h-[200px] rounded-b border border-t-0 border-border overflow-hidden">
        <textarea
          ref={taRef}
          defaultValue={value}
          onChange={(e) => { onChange(e.target.value); syncScroll(); }}
          onScroll={syncScroll}
          onKeyDown={(e) => handleKeyDown(e, onChange)}
          spellCheck={false}
          className="json-ed-ta relative w-full min-h-[200px] m-0 p-2 bg-transparent resize-y outline-none border-none text-transparent caret-foreground [field-sizing:content]"
        />

        <pre
          ref={preRef}
          className="json-ed-pre absolute inset-0 m-0 p-2 overflow-hidden pointer-events-none z-10"
        >
          {lines.map((line, i) => {
            if (hiddenLines.has(i)) return null;

            const info = getFoldInfo(i);
            const isFolded = info === 'collapsed';

            return (
              <div key={i} className="json-ed-line" data-line={i + 1}>
                {info === 'expanded' ? (
                  <button type="button" className="json-ed-fold" onClick={() => handleFold(i)}>▼</button>
                ) : info === 'collapsed' ? (
                  <button type="button" className="json-ed-fold" onClick={() => handleUnfold(i)}>▶</button>
                ) : null}
                <span dangerouslySetInnerHTML={{
                  __html: isFolded
                    ? highlight(line.slice(0, line.trimEnd().length - 1)) + `<span class="jf">${line.trimEnd().slice(-1)} … ${line.trimEnd().slice(-1) === '{' ? '}' : ']'}</span>`
                    : (highlight(line) || ' ')
                }} />
              </div>
            );
          })}
        </pre>
      </div>
    </div>
  );
}
