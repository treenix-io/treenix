// TipTap Mark: inline link to a Treenix tree node
// Renders as <a href={makeHref(path)} data-node-path> — href makes right-click "open in new tab" work.
// Click delegation in renderers-impl.tsx intercepts left-click for SPA navigation.
// Input rule: [[/path]] or [[/path|label]] → creates node link

import { InputRule, Mark, mergeAttributes } from '@tiptap/core';

export type NodeLinkOptions = {
  // null return = path falls outside active route's prefix → render <a> without href
  makeHref: ((path: string) => string | null) | null;
};

export const NodeLink = Mark.create<NodeLinkOptions>({
  name: 'nodeLink',
  priority: 1000,
  inclusive: false,

  addOptions() {
    return { makeHref: null };
  },

  addAttributes() {
    return {
      // Resolved absolute tree path — runtime navigation contract.
      path: { default: null },
      // Original markdown href as authored on disk. Used to round-trip relative forms
      // (`./types.md`, `foo.md?v=1#a`) through tiptapToMd. Only respected on encode if
      // resolveLinkPath(sourceHref, basePath) still equals path — otherwise we fall back
      // to the absolute path so a moved page or retargeted link can't emit a stale href.
      sourceHref: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'a[data-node-path]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const path = HTMLAttributes.path as string | null;
    const href = path && this.options.makeHref ? this.options.makeHref(path) : null;
    const attrs: Record<string, string> = {
      'data-node-path': path ?? '',
      class: 'node-link',
    };
    if (href) attrs.href = href;
    return ['a', mergeAttributes(attrs), 0];
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
