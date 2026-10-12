// Markdown file ↔ doc.page node codec for FS tree
// Decode: .md file → doc.page node (title from first H1, content as Tiptap JSON)
// Encode: doc.page node → .md file (Tiptap JSON → markdown)
// Paths are extensionless — encode appends .md

import type { NodeData } from '@treenx/core';
import { register } from '@treenx/core';
import { readFile, writeFile } from 'node:fs/promises';
import type { DocFrontmatterData } from './frontmatter';
import { decodeMarkdown, encodeMarkdown } from './native-codec';
import type { TiptapNode } from './markdown';

register(
  'text/markdown',
  'decode',
  async (filePath: string, nodePath: string, outerPath?: string) => {
    const raw = await readFile(filePath, 'utf-8');
    return decodeMarkdown(raw, nodePath, outerPath ?? nodePath);
  },
);

register('doc.page', 'encode', async (node: NodeData, filePath: string, outerPath?: string) => {
  const { title, content } = node as { title?: string; content?: TiptapNode };
  const fmComp = (node as Record<string, unknown>)['doc.frontmatter'] as
    | (DocFrontmatterData & { $type?: string })
    | undefined;

  // Pass outerPath as basePath so nodeLinks with a preserved sourceHref (`./types.md`)
  // can verify their invariant and round-trip in the original relative form.
  // Drop runtime-only $type before serialization.
  const { $type: _omit, ...fmData } = fmComp ?? {};
  const md = encodeMarkdown({ $path: node.$path, title, content }, outerPath ?? node.$path, fmData);

  // Extensionless path → append .md
  const actualPath = filePath.endsWith('.md') ? filePath : filePath + '.md';
  await writeFile(actualPath, md, 'utf-8');
});
