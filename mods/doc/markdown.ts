// Markdown ↔ Tiptap JSON converters
// Used by: text.ts (Tiptap→md), fs-codec decode/encode (.md files ↔ doc.page nodes)

export type TiptapNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
};

// ── Tiptap JSON → Markdown ──

export function inlineToMd(node: TiptapNode): string {
  if (node.text) {
    let t = node.text;
    const nodeLink = node.marks?.find((m) => m.type === 'nodeLink');
    if (nodeLink) {
      const path = (nodeLink as { type: string; attrs?: Record<string, unknown> }).attrs?.path ?? '';
      t = `[${t}](treenix:${path})`;
    }
    if (node.marks?.some((m) => m.type === 'bold')) t = `**${t}**`;
    if (node.marks?.some((m) => m.type === 'italic')) t = `*${t}*`;
    if (node.marks?.some((m) => m.type === 'code')) t = `\`${t}\``;
    return t;
  }
  return (node.content ?? []).map(inlineToMd).join('');
}

export function tiptapToMd(node: TiptapNode): string {
  const children = node.content ?? [];

  switch (node.type) {
    case 'doc':
      return children.map((c) => tiptapToMd(c)).join('\n\n');

    case 'heading': {
      const level = (node.attrs?.level as number) ?? 1;
      return '#'.repeat(level) + ' ' + children.map(inlineToMd).join('');
    }

    case 'paragraph':
      return children.map(inlineToMd).join('');

    case 'bulletList':
      return children.map((c) => tiptapToMd(c)).join('\n');

    case 'orderedList':
      return children.map((c, i) => `${i + 1}. ${tiptapToMd(c).replace(/^- /, '')}`).join('\n');

    case 'taskList':
      return children.map((c) => tiptapToMd(c)).join('\n');

    case 'taskItem': {
      const checked = node.attrs?.checked ? 'x' : ' ';
      const inner = children.map((c) => tiptapToMd(c)).join('\n');
      return `- [${checked}] ${inner}`;
    }

    case 'listItem': {
      const inner = children.map((c) => tiptapToMd(c)).join('\n');
      return '- ' + inner;
    }

    case 'table': {
      const rows = children;
      if (!rows.length) return '';
      const mdRows = rows.map((row) => {
        const cells = (row.content ?? []).map((cell) => {
          const text = (cell.content ?? []).map((c) => tiptapToMd(c)).join('').replace(/\|/g, '\\|');
          return text.trim();
        });
        return '| ' + cells.join(' | ') + ' |';
      });
      // Insert separator after header row
      const firstRow = rows[0];
      const colCount = (firstRow.content ?? []).length;
      const sep = '| ' + Array(colCount).fill('---').join(' | ') + ' |';
      return [mdRows[0], sep, ...mdRows.slice(1)].join('\n');
    }

    case 'tableRow':
    case 'tableCell':
    case 'tableHeader':
      return children.map((c) => tiptapToMd(c)).join('');

    case 'codeBlock': {
      const lang = (node.attrs?.language as string) ?? '';
      return '```' + lang + '\n' + children.map(inlineToMd).join('') + '\n```';
    }

    case 'blockquote':
      return children.map((c) => '> ' + tiptapToMd(c)).join('\n');

    case 'horizontalRule':
      return '---';

    case 'treenixBlock': {
      const ref = node.attrs?.ref as string | null;
      const type = node.attrs?.type as string | null;
      if (ref) return `[Component: ${type ?? 'unknown'} at ${ref}]`;
      return `[Component: ${type ?? 'unknown'} (inline)]`;
    }

    case 'queryBlock': {
      const qPath = node.attrs?.path as string | null;
      const qType = node.attrs?.type as string | null;
      const qFilters = node.attrs?.filters as { field: string; value: string }[] | null;
      const parts = [`[Query: ${qPath ?? '/'}`];
      if (qType) parts.push(`type=${qType}`);
      if (qFilters?.length) parts.push(qFilters.map(f => `${f.field}=${f.value}`).join(', '));
      return parts.join(' ') + ']';
    }

    default:
      return children.map((c) => tiptapToMd(c)).join('');
  }
}

// ── Markdown → Tiptap JSON ──

// Resolve a markdown link href to an absolute tree path, or null if external.
// External: http(s)://, mailto:, fragment-only (#anchor)
// treenix:/path → /path
// /abs → /abs
// relative (./, ../, foo.md) → resolved against dirname(basePath)
export function resolveLinkPath(href: string, basePath?: string): string | null {
  if (!href) return null;
  if (/^(?:[a-z][a-z0-9+.-]*:)/i.test(href)) {
    if (href.startsWith('treenix:')) return href.slice('treenix:'.length) || null;
    return null; // http(s), mailto, etc — external
  }
  if (href.startsWith('#')) return null; // fragment only — same-page anchor, not a node
  // Strip query/fragment for resolution
  const q = href.indexOf('?');
  const f = href.indexOf('#');
  let path = href;
  const cut = [q, f].filter((n) => n >= 0).sort((a, b) => a - b)[0];
  if (cut !== undefined) path = href.slice(0, cut);
  if (!path) return null;
  if (path.startsWith('/')) return path;
  if (!basePath) return null;
  // Resolve relative against parent dir of basePath
  const dir = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath.slice(0, basePath.lastIndexOf('/'));
  const segments = (dir + '/' + path).split('/');
  const stack: string[] = [];
  for (const seg of segments) {
    if (!seg || seg === '.') continue;
    if (seg === '..') stack.pop();
    else stack.push(seg);
  }
  return '/' + stack.join('/');
}

export function mdToTiptap(markdown: string, basePath?: string): TiptapNode {
  const lines = markdown.split('\n');
  const blocks: TiptapNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Empty line → skip
    if (!line.trim()) { i++; continue; }

    // Heading. Allow empty title (e.g. "## ") so we always advance — otherwise
    // the paragraph fallback below skips heading-like lines and we infinite-loop.
    const headingMatch = line.match(/^(#{1,6})\s*(.*?)\s*$/);
    if (headingMatch && headingMatch[1]) {
      const title = headingMatch[2];
      if (title) {
        blocks.push({
          type: 'heading',
          attrs: { level: headingMatch[1].length },
          content: parseInline(title, basePath),
        });
      }
      i++;
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim()) || /^\*\*\*+$/.test(line.trim())) {
      blocks.push({ type: 'horizontalRule' });
      i++;
      continue;
    }

    // Code block
    if (line.trimStart().startsWith('```')) {
      const lang = line.trim().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      blocks.push({
        type: 'codeBlock',
        attrs: lang ? { language: lang } : {},
        content: [{ type: 'text', text: codeLines.join('\n') }],
      });
      continue;
    }

    // Task list: - [ ] or - [x]
    if (/^[-*]\s\[[x ]\]\s/i.test(line.trimStart())) {
      const items: TiptapNode[] = [];
      while (i < lines.length && /^[-*]\s\[[x ]\]\s/i.test(lines[i].trimStart())) {
        const m = lines[i].trimStart().match(/^[-*]\s\[([x ])\]\s+(.*)/i)!;
        const checked = m[1].toLowerCase() === 'x';
        items.push({
          type: 'taskItem',
          attrs: { checked },
          content: [{ type: 'paragraph', content: parseInline(m[2], basePath) }],
        });
        i++;
      }
      blocks.push({ type: 'taskList', content: items });
      continue;
    }

    // Bullet list
    if (/^[-*]\s/.test(line.trimStart())) {
      const items: TiptapNode[] = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i].trimStart()) && !/^[-*]\s\[[x ]\]\s/i.test(lines[i].trimStart())) {
        const text = lines[i].trimStart().replace(/^[-*]\s+/, '');
        items.push({
          type: 'listItem',
          content: [{ type: 'paragraph', content: parseInline(text, basePath) }],
        });
        i++;
      }
      if (items.length) blocks.push({ type: 'bulletList', content: items });
      continue;
    }

    // Ordered list
    if (/^\d+\.\s/.test(line.trimStart())) {
      const items: TiptapNode[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i].trimStart())) {
        const text = lines[i].trimStart().replace(/^\d+\.\s+/, '');
        items.push({
          type: 'listItem',
          content: [{ type: 'paragraph', content: parseInline(text, basePath) }],
        });
        i++;
      }
      blocks.push({ type: 'orderedList', content: items });
      continue;
    }

    // Blockquote
    if (line.trimStart().startsWith('> ')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith('> ')) {
        quoteLines.push(lines[i].trimStart().slice(2));
        i++;
      }
      blocks.push({
        type: 'blockquote',
        content: [{ type: 'paragraph', content: parseInline(quoteLines.join(' '), basePath) }],
      });
      continue;
    }

    // Table: lines starting with |
    if (line.trimStart().startsWith('|')) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith('|')) {
        tableLines.push(lines[i].trim());
        i++;
      }
      // Filter out separator rows (| --- | --- |)
      const dataRows = tableLines.filter((r) => !/^\|[-\s|:]+\|$/.test(r));
      if (dataRows.length) {
        const tiptapRows: TiptapNode[] = dataRows.map((row, rowIdx) => {
          const cells = row.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
          const cellType = rowIdx === 0 ? 'tableHeader' : 'tableCell';
          return {
            type: 'tableRow',
            content: cells.map((cellText) => ({
              type: cellType,
              attrs: { colspan: 1, rowspan: 1 },
              content: [{ type: 'paragraph', content: parseInline(cellText, basePath) }],
            })),
          };
        });
        blocks.push({ type: 'table', content: tiptapRows });
      }
      continue;
    }

    // Paragraph (default)
    const paraLines: string[] = [];
    while (i < lines.length && lines[i].trim() && !lines[i].match(/^#{1,6}\s/) && !lines[i].match(/^[-*]\s/) && !lines[i].match(/^\d+\.\s/) && !lines[i].trimStart().startsWith('```') && !lines[i].trimStart().startsWith('> ') && !lines[i].trimStart().startsWith('|') && !/^---+$/.test(lines[i].trim())) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length) {
      blocks.push({ type: 'paragraph', content: parseInline(paraLines.join(' '), basePath) });
    }
  }

  return { type: 'doc', content: blocks.length ? blocks : [{ type: 'paragraph' }] };
}

// Strip empty text nodes (text === '') anywhere in the tree. ProseMirror
// throws "RangeError: Empty text nodes are not allowed" when setContent
// receives one. Defensive filter for legacy doc.page nodes whose content
// was produced before parseInline learned not to emit empties.
export function sanitizeTiptap(node: TiptapNode): TiptapNode {
  if (!node.content) return node;
  const cleaned: TiptapNode[] = [];
  for (const child of node.content) {
    if (child.type === 'text') {
      if (child.text) cleaned.push(child);
    } else {
      cleaned.push(sanitizeTiptap(child));
    }
  }
  return { ...node, content: cleaned };
}

type Mark = NonNullable<TiptapNode['marks']>[number];

function parseInline(text: string, basePath?: string, parentMarks: Mark[] = []): TiptapNode[] {
  const nodes: TiptapNode[] = [];
  // Inline parser: **bold**, *italic*, `code`, [text](url). Marks nest recursively
  // so `**[link](x)**` and `- **[Storage](./x.md)**` produce a bold+nodeLink span.
  // Link match groups: [5]=text, [6]=url
  const re = /(\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+?)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;

  function pushPlain(s: string) {
    if (!s) return;
    nodes.push(parentMarks.length ? { type: 'text', text: s, marks: parentMarks } : { type: 'text', text: s });
  }

  for (const match of text.matchAll(re)) {
    pushPlain(text.slice(last, match.index!));

    if (match[2] !== undefined) {
      // Bold — recurse so nested links/italic/code inside get parsed too.
      nodes.push(...parseInline(match[2], basePath, [...parentMarks, { type: 'bold' }]));
    } else if (match[3] !== undefined) {
      nodes.push(...parseInline(match[3], basePath, [...parentMarks, { type: 'italic' }]));
    } else if (match[4] !== undefined) {
      // Code spans don't recurse — markdown spec: no inner formatting.
      const codeMarks: Mark[] = [...parentMarks, { type: 'code' }];
      if (match[4]) nodes.push({ type: 'text', text: match[4], marks: codeMarks });
    } else if (match[5] !== undefined && match[6] !== undefined) {
      const linkText = match[5];
      const href = match[6];
      const treePath = resolveLinkPath(href, basePath);
      const linkMarks: Mark[] = treePath
        ? [...parentMarks, { type: 'nodeLink', attrs: { path: treePath } }]
        : parentMarks;
      // Recurse on link text in case it has its own marks (e.g. **[bold link](x)**
      // arrives here as already-bold; literal `[*foo*](x)` resolves *foo* inside).
      nodes.push(...parseInline(linkText, basePath, linkMarks));
    }

    last = match.index! + match[0].length;
  }

  pushPlain(text.slice(last));

  return nodes;
}
