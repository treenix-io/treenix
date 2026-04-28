import { mergeAttributes, Node } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { TreenixBlockView } from './treenix-block-view';

export const TreenixBlock = Node.create({
  name: 'treenixBlock',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      ref: { default: null },
      type: { default: null },
      props: { default: {} },
      context: { default: 'react' },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-treenix-block]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-treenix-block': '' })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(TreenixBlockView);
  },
});
