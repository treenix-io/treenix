import './editor.css';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { Table } from '@tiptap/extension-table';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TableRow from '@tiptap/extension-table-row';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import { Editor, EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { checkBeforeNavigate } from '@treenx/react';
import { useNavigate } from '@treenx/react/hooks';
import { Input } from '@treenx/react/ui/input';
import { common, createLowlight } from 'lowlight';
import { type MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef } from 'react';
import { CodeCopyButtons } from './code-copy-buttons';
import { sanitizeTiptap, type TiptapNode } from './markdown';
import { NodeLink } from './node-link';
import { getNodeLinkPath } from './node-link-click';
import { SlashCommand } from './slash-command';
import { Toolbar } from './toolbar';
import { TreenixBlock } from './treenix-block';

const lowlight = createLowlight(common);

const baseExtensions = [
  StarterKit.configure({
    codeBlock: false,
    link: {
      HTMLAttributes: {
        target: '_blank',
        rel: 'noopener noreferrer nofollow',
        class: 'node-link',
      },
    },
  }),
  CodeBlockLowlight.configure({ lowlight }),
  TaskList,
  TaskItem.configure({ nested: true }),
  Table.configure({ resizable: false }),
  TableRow,
  TableCell,
  TableHeader,
  TreenixBlock,
  SlashCommand,
];

type BlockProps = { value: any; onChange?: (data: any) => void };

export function DocPageView({ value, onChange }: BlockProps) {
  const suppressRef = useRef(false);
  const contentRef = useRef<unknown>(value.content);
  const dirtyRef = useRef(false);
  const editable = !!onChange;
  const { navigate, makeHref } = useNavigate();

  const extensions = useMemo(
    () => [...baseExtensions, NodeLink.configure({ makeHref })],
    [makeHref],
  );

  const editorOptions = useMemo(() => ({
    extensions,
    content: sanitizeTiptap(value.content as TiptapNode),
    editable,
    onUpdate: ({ editor }: { editor: Editor }) => {
      if (suppressRef.current) return;
      dirtyRef.current = true;
      const json = editor.getJSON();
      contentRef.current = json;
      onChange?.({ content: json });
    },
  }), [editable, extensions]);

  const editor = useEditor(editorOptions);

  // Reset dirty flag on navigation (path change) so sync accepts new doc content
  useEffect(() => { dirtyRef.current = false; }, [value.$path]);

  // Sync editor content from tree subscription.
  // Skip when dirty (local edits not yet confirmed by server) to prevent
  // stale server values from reverting the editor mid-edit.
  useEffect(() => {
    if (value.content === contentRef.current) return;
    if (dirtyRef.current) return;
    contentRef.current = value.content;
    suppressRef.current = true;
    editor.commands.setContent(sanitizeTiptap(value.content as TiptapNode));
    suppressRef.current = false;
  }, [editor, value.content]);

  // Sync docPath for slash commands (e.g. /component)
  useEffect(() => {
    if (!value.$path) return;

    const storage = editor.storage as typeof editor.storage & {
      slashCommand?: { docPath: string };
    };

    storage.slashCommand ??= { docPath: '' };
    storage.slashCommand.docPath = value.$path;
  }, [editor, value.$path]);

  // Sync editable state
  useEffect(() => {
    if (editor.isEditable !== editable) editor.setEditable(editable);
  }, [editor, editable]);

  const handleNodeLinkClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const path = getNodeLinkPath(event.target);
    if (!path) return;

    // Outside the active route's prefix: makeHref returns null → leave the
    // browser default (which is no-op since we render <a> without href). Don't
    // preventDefault, don't run unsaved-changes guard.
    if (makeHref(path) === null) return;

    event.preventDefault();
    event.stopPropagation();

    if (!checkBeforeNavigate()) return;

    navigate(path);
  };

  return (
    <div className="max-w-3xl mx-auto py-6 px-4">
      {/* Title */}
      <div className="mb-5">
        {onChange ? (
          <Input
            type="text"
            value={value.title || ''}
            onChange={(e) => onChange({ title: e.target.value })}
            placeholder="Untitled"
            className="w-full text-2xl font-semibold tracking-tight bg-transparent border-none shadow-none outline-none text-foreground placeholder:text-muted-foreground/50 p-0 m-0 leading-tight [font-family:inherit]"
          />
        ) : (
          value.title && <h1 className="text-2xl font-semibold tracking-tight text-foreground">{value.title}</h1>
        )}
      </div>

      {/* Toolbar — only in edit mode */}
      {onChange && <Toolbar editor={editor} />}

      {/* Editor content */}
      <div
        className={`min-h-[300px] ${onChange ? 'pt-4' : ''}`}
        onClickCapture={handleNodeLinkClick}
        onDrop={(e) => {
          if (!editor || !onChange) return;
          const path = e.dataTransfer.getData('application/treenix-path');
          if (!path) return;
          e.preventDefault();
          e.stopPropagation();
          editor.chain().focus().insertContent({
            type: 'treenixBlock',
            attrs: { ref: path, type: null, props: {} },
          }).run();
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('application/treenix-path')) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
          }
        }}
      >
        <EditorContent editor={editor} />
        <CodeCopyButtons editor={editor} enabled={!editable} contentVersion={value.content} />
      </div>
    </div>
  );
}
