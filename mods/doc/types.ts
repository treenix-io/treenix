import { registerType } from '@treenity/core/comp';

/** Rich document — Tiptap JSON with embedded Treenity components */
class DocPage {
  /** @title Title */
  title = 'Untitled';
  /** @title Content */
  content = '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Нажмите кнопку Edit чтобы начать редактирование."}]}]}';
}
registerType('doc.page', DocPage);
