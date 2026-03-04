// Markdown file ↔ doc.page node codec for FS store
// Decode: .md file → doc.page node (title from first H1, content as Tiptap JSON)
// Encode: doc.page node → .md file (Tiptap JSON → markdown)
// Paths are extensionless — encode appends .md

import type { NodeData } from '@treenity/core/core';
import { register } from '@treenity/core/core';
import { readFile, writeFile } from 'node:fs/promises';
import { mdToTiptap, type TiptapNode, tiptapToMd } from './markdown';

register('text/markdown', 'decode', async (filePath: string, nodePath: string) => {
  const raw = await readFile(filePath, 'utf-8');
  const tiptapDoc = mdToTiptap(raw);

  // Extract title from first heading if present
  let title = '';
  const firstBlock = tiptapDoc.content?.[0];
  if (firstBlock?.type === 'heading' && firstBlock.attrs?.level === 1) {
    title = firstBlock.content?.map((n) => n.text ?? '').join('') ?? '';
    // Remove H1 from content since it's in the title field
    tiptapDoc.content = tiptapDoc.content!.slice(1);
  }

  return {
    $path: nodePath,
    $type: 'doc.page',
    title,
    content: JSON.stringify(tiptapDoc),
  } as NodeData;
});

register('doc.page', 'encode', async (node: NodeData, filePath: string) => {
  const { title, content } = node as any;
  let md = '';

  if (title) md += `# ${title}\n\n`;

  if (content) {
    try {
      const doc = JSON.parse(content) as TiptapNode;
      md += tiptapToMd(doc);
    } catch {
      md += content;
    }
  }

  // Extensionless path → append .md
  const actualPath = filePath.endsWith('.md') ? filePath : filePath + '.md';
  await writeFile(actualPath, md.trimEnd() + '\n', 'utf-8');
});
