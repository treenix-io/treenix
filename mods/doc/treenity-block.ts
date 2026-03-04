import { mergeAttributes, Node } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { TreenityBlockView } from './treenity-block-view';

export const TreenityBlock = Node.create({
  name: 'treenityBlock',
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
    return [{ tag: 'div[data-treenity-block]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-treenity-block': '' })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(TreenityBlockView);
  },
});
