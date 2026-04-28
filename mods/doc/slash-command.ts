import { Extension } from '@tiptap/core';
import { ReactRenderer } from '@tiptap/react';
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion';
import { SlashMenu, type SlashMenuItem } from './slash-menu';

const defaultItems: SlashMenuItem[] = [
  {
    title: 'Heading 1',
    group: 'Text',
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleHeading({ level: 1 }).run(),
  },
  {
    title: 'Heading 2',
    group: 'Text',
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleHeading({ level: 2 }).run(),
  },
  {
    title: 'Heading 3',
    group: 'Text',
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleHeading({ level: 3 }).run(),
  },
  {
    title: 'Bullet List',
    group: 'Text',
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    title: 'Ordered List',
    group: 'Text',
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  {
    title: 'Code Block',
    group: 'Text',
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
  },
  {
    title: 'Quote',
    group: 'Text',
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
  },
  {
    title: 'Divider',
    group: 'Text',
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
  },
  {
    title: 'Ref',
    group: 'Treenix',
    command: () => {},
    picker: 'ref',
  },
  {
    title: 'Component',
    group: 'Treenix',
    command: () => {},
    picker: 'component',
  },
  {
    title: 'Node Link',
    group: 'Treenix',
    command: () => {},
    picker: 'link',
  },
];

declare module '@tiptap/core' {
  interface Storage {
    slashCommand: { docPath: string };
  }
}

export const SlashCommand = Extension.create<any, { docPath: string }>({
  name: 'slashCommand',

  addStorage() {
    return { docPath: '' };
  },

  addOptions() {
    return {
      suggestion: {
        char: '/',
        command: ({ editor, range, props }: any) => {
          props.command({ editor, range });
        },
      } as Partial<SuggestionOptions>,
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
        items: ({ query }: { query: string }) =>
          defaultItems.filter((item) =>
            item.title.toLowerCase().includes(query.toLowerCase()),
          ),
        render: () => {
          let component: ReactRenderer;

          return {
            onStart: (props: any) => {
              component = new ReactRenderer(SlashMenu, {
                props: { ...props, docPath: this.storage.docPath },
                editor: props.editor,
              });
              document.body.appendChild(component.element);
              positionElement(component.element, props.clientRect);
            },

            onUpdate: (props: any) => {
              component.updateProps({ ...props, docPath: this.storage.docPath });
              positionElement(component.element, props.clientRect);
            },

            onKeyDown: (props: any) => {
              if (props.event.key === 'Escape') {
                component?.element?.remove();
                component?.destroy();
                return true;
              }
              return (component?.ref as any)?.onKeyDown?.(props) ?? false;
            },

            onExit: () => {
              component?.element?.remove();
              component?.destroy();
            },
          };
        },
      }),
    ];
  },
});

function positionElement(el: HTMLElement, clientRect: (() => DOMRect | null) | null) {
  const rect = clientRect?.();
  if (!rect) return;

  const menuH = 300;
  const menuW = 210;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const left = Math.min(rect.left, vw - menuW - 8);
  const fitsBelow = rect.bottom + 4 + menuH < vh;
  const top = fitsBelow ? rect.bottom + 4 : rect.top - menuH - 4;

  Object.assign(el.style, {
    position: 'fixed',
    left: `${Math.max(4, left)}px`,
    top: `${Math.max(4, top)}px`,
    zIndex: '9999',
  });
}
