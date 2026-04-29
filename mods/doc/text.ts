import { register } from '@treenx/core';
import { type TiptapNode, tiptapToMd } from './markdown';

register('doc.page', 'text', (data: unknown) => {
  const d = data as { title?: string; content?: TiptapNode };
  const lines: string[] = [];
  if (d.title) lines.push(`# ${d.title}`);

  if (d.content) {
    const text = tiptapToMd(d.content);
    if (text) lines.push(text);
  }

  return lines.join('\n\n');
});
