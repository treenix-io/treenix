import { registerType } from '@treenity/core/comp';

/** Rich document — Tiptap JSON with embedded Treenity components */
class DocPage {
  /** @title Title */
  title = '';
  /** @title Content @format hidden */
  content = '';
}
registerType('doc.page', DocPage);
