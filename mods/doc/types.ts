import { declareClientType } from '@treenx/core/comp/client-declaration';
import { declareOpenModule } from '@treenx/core/kernel/module-declaration';
import { declareText } from '@treenx/core/contexts/text';
import { tiptapToMd } from './markdown';


/** Rich document — Tiptap JSON with embedded Treenix components */
export class DocPage {
  /** @title Title */
  title = 'Untitled';
  /** @title Content */
  content = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Press Edit to start editing.' }] },
    ],
  };
}
const declaredDocPage = declareClientType('doc.page', DocPage);

/** YAML frontmatter from a markdown file. Known keys are typed; arbitrary keys
 *  preserved in `extra` so we round-trip third-party SSG conventions losslessly. */
export class DocFrontmatter {
  /** @title Title */ title?: string;
  /** @title Description */ description?: string;
  /** @title Tags */ tags?: string[];
  /** @title Section */ section?: string;
  /** @title Order */ order?: number;
  /** @title Extra */ extra?: Record<string, unknown>;
}
const declaredDocFrontmatter = declareClientType('doc.frontmatter', DocFrontmatter);

const declaredText = declareText(DocPage, (data: Partial<DocPage>) => {
  const lines: string[] = [];
  if (data.title) lines.push(`# ${data.title}`);
  if (data.content) {
    const text = tiptapToMd(data.content);
    if (text) lines.push(text);
  }
  return lines.join('\n\n');
});

export const clientModules = [declareOpenModule('@treenx/mods/doc/types', [declaredText], [
  declaredDocPage,
  declaredDocFrontmatter,
])];
