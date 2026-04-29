import { registerType } from '@treenx/core/comp';

/** Rich document — Tiptap JSON with embedded Treenix components */
class DocPage {
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
registerType('doc.page', DocPage);

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
registerType('doc.frontmatter', DocFrontmatter);
