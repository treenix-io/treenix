import { register } from '@treenity/core/core';
import { type TiptapNode, tiptapToMd } from './markdown';

register('doc.page', 'text', (data: unknown) => {
  const d = data as { title?: string; content?: string };
  const lines: string[] = [];
  if (d.title) lines.push(`# ${d.title}`);

  if (d.content) {
    try {
      const doc = JSON.parse(d.content) as TiptapNode;
      const text = tiptapToMd(doc);
      if (text) lines.push(text);
    } catch {
      if (d.content) lines.push(d.content);
    }
  }

  return lines.join('\n\n');
});
