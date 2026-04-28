// Markdown file ↔ doc.page node codec for FS tree
// Decode: .md file → doc.page node (title from first H1, content as Tiptap JSON)
// Encode: doc.page node → .md file (Tiptap JSON → markdown)
// Paths are extensionless — encode appends .md

import type { NodeData } from '@treenx/core';
import { register } from '@treenx/core';
import { readFile, writeFile } from 'node:fs/promises';
import { type DocFrontmatterData, serializeFrontmatter, splitFrontmatter } from './frontmatter';
import { mdToTiptap, type TiptapNode, tiptapToMd } from './markdown';

register('text/markdown', 'decode', async (filePath: string, nodePath: string, outerPath?: string) => {
  const raw = await readFile(filePath, 'utf-8');
  // Strip YAML frontmatter (---...---) before parsing markdown body so it doesn't
  // get rendered as content. Known keys (title/description/tags/section/order)
  // become a typed `doc.frontmatter` component; unknown keys go into `extra`.
  const { frontmatter, body } = splitFrontmatter(raw);

  // Resolve relative links against the OUTER tree path so navigation lands on the
  // correct mounted node (e.g. /docs/public/index.md → links into /docs/public/...).
  const tiptapDoc = mdToTiptap(body, outerPath ?? nodePath);

  // Title precedence: frontmatter `title:` > first H1 > empty.
  let title = frontmatter?.title ?? '';
  const firstBlock = tiptapDoc.content?.[0];
  if (firstBlock?.type === 'heading' && firstBlock.attrs?.level === 1) {
    const h1 = firstBlock.content?.map((n) => n.text ?? '').join('') ?? '';
    if (!title) title = h1;
    // Always strip the H1 from content (whether or not it became the title).
    tiptapDoc.content = tiptapDoc.content!.slice(1);
  }

  const node: Record<string, unknown> = {
    $path: nodePath,
    $type: 'doc.page',
    title,
    content: tiptapDoc,
  };
  if (frontmatter) {
    // Attach as a named-key component (composition pattern). The key name matches
    // the type for clarity at the wire level.
    node['doc.frontmatter'] = { $type: 'doc.frontmatter', ...frontmatter };
  }
  return node as NodeData;
});

register('doc.page', 'encode', async (node: NodeData, filePath: string) => {
  const { title, content } = node as { title?: string; content?: TiptapNode };
  const fmComp = (node as Record<string, unknown>)['doc.frontmatter'] as
    | (DocFrontmatterData & { $type?: string })
    | undefined;

  let md = '';
  if (fmComp) {
    // Drop runtime-only $type before serialization.
    const { $type: _omit, ...fmData } = fmComp;
    md += serializeFrontmatter(fmData);
  }

  if (title) md += `# ${title}\n\n`;
  if (content) md += tiptapToMd(content);

  // Extensionless path → append .md
  const actualPath = filePath.endsWith('.md') ? filePath : filePath + '.md';
  await writeFile(actualPath, md.trimEnd() + '\n', 'utf-8');
});
