// Markdown ↔ Tiptap JSON converters
// Used by: text.ts (Tiptap→md), fs-codec decode/encode (.md files ↔ doc.page nodes)

export type TiptapNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
  text?: string;
  marks?: { type: string }[];
};

// ── Tiptap JSON → Markdown ──

export function inlineToMd(node: TiptapNode): string {
  if (node.text) {
    let t = node.text;
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

    case 'treenityBlock': {
      const ref = node.attrs?.ref as string | null;
      const type = node.attrs?.type as string | null;
      if (ref) return `[Component: ${type ?? 'unknown'} at ${ref}]`;
      return `[Component: ${type ?? 'unknown'} (inline)]`;
    }

    default:
      return children.map((c) => tiptapToMd(c)).join('');
  }
}

// ── Markdown → Tiptap JSON ──

export function mdToTiptap(markdown: string): TiptapNode {
  const lines = markdown.split('\n');
  const blocks: TiptapNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Empty line → skip
    if (!line.trim()) { i++; continue; }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        attrs: { level: headingMatch[1].length },
        content: parseInline(headingMatch[2]),
      });
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
          content: [{ type: 'paragraph', content: parseInline(m[2]) }],
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
          content: [{ type: 'paragraph', content: parseInline(text) }],
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
          content: [{ type: 'paragraph', content: parseInline(text) }],
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
        content: [{ type: 'paragraph', content: parseInline(quoteLines.join(' ')) }],
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
              content: [{ type: 'paragraph', content: parseInline(cellText) }],
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
      blocks.push({ type: 'paragraph', content: parseInline(paraLines.join(' ')) });
    }
  }

  return { type: 'doc', content: blocks.length ? blocks : [{ type: 'paragraph' }] };
}

function parseInline(text: string): TiptapNode[] {
  const nodes: TiptapNode[] = [];
  // Simple regex-based inline parser: **bold**, *italic*, `code`
  const re = /(\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+?)`)/g;
  let last = 0;

  for (const match of text.matchAll(re)) {
    if (match.index! > last) {
      nodes.push({ type: 'text', text: text.slice(last, match.index!) });
    }

    if (match[2]) {
      nodes.push({ type: 'text', text: match[2], marks: [{ type: 'bold' }] });
    } else if (match[3]) {
      nodes.push({ type: 'text', text: match[3], marks: [{ type: 'italic' }] });
    } else if (match[4]) {
      nodes.push({ type: 'text', text: match[4], marks: [{ type: 'code' }] });
    }

    last = match.index! + match[0].length;
  }

  if (last < text.length) {
    nodes.push({ type: 'text', text: text.slice(last) });
  }

  return nodes.length ? nodes : [{ type: 'text', text: text || '' }];
}
