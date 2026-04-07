// TipTap Mark: inline link to a Treenity tree node
// Renders as <a> with data-node-path, click handled via event delegation in renderers.tsx
// Input rule: [[/path]] or [[/path|label]] → creates node link

import { InputRule, Mark, mergeAttributes } from '@tiptap/core';

export const NodeLink = Mark.create({
  name: 'nodeLink',
  priority: 1000,
  inclusive: false,

  addAttributes() {
    return {
      path: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'a[data-node-path]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['a', mergeAttributes({
      'data-node-path': HTMLAttributes.path,
      class: 'node-link',
    }), 0];
  },

  addInputRules() {
    return [
      new InputRule({
        find: /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/,
        handler: ({ state, range, match }) => {
          const path = match[1];
          const label = match[2] || path.split('/').filter(Boolean).pop() || path;
          const mark = this.type.create({ path });
          state.tr.replaceWith(range.from, range.to, state.schema.text(label, [mark]));
        },
      }),
    ];
  },
});
