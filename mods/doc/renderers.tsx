import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { Table } from '@tiptap/extension-table';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TableRow from '@tiptap/extension-table-row';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import { Editor, EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { register } from '@treenity/core';
import { Input } from '@treenity/react/ui/input';
import { common, createLowlight } from 'lowlight';
import { useEffect, useMemo, useRef } from 'react';
import { SlashCommand } from './slash-command';
import { Toolbar } from './toolbar';
import { TreenityBlock } from './treenity-block';

const lowlight = createLowlight(common);

const extensions = [
  StarterKit.configure({ codeBlock: false }),
  CodeBlockLowlight.configure({ lowlight }),
  TaskList,
  TaskItem.configure({ nested: true }),
  Table.configure({ resizable: false }),
  TableRow,
  TableCell,
  TableHeader,
  TreenityBlock,
  SlashCommand,
];

type BlockProps = { value: any; onChange?: (data: any) => void };

function DocPageView({ value, onChange }: BlockProps) {
  const suppressRef = useRef(false);
  const contentRef = useRef(value.content);
  const parsedContent = useMemo(() => parseContent(value.content), [value.content]);
  const editable = !!onChange;

  const editorOptions = useMemo(() => ({
    extensions,
    content: parsedContent,
    editable,
    onUpdate: ({ editor }: { editor: Editor }) => {
      if (suppressRef.current) return;
      const json = JSON.stringify(editor.getJSON());
      contentRef.current = json;
      onChange?.({ content: json });
    },
  }), [editable]);

  const editor = useEditor(editorOptions);

  // Sync editor content when node changes (navigating between docs)
  useEffect(() => {
    if (value.content === contentRef.current) return;
    contentRef.current = value.content;
    suppressRef.current = true;
    editor.commands.setContent(parsedContent);
    suppressRef.current = false;
  }, [editor, parsedContent]);

  // Sync docPath for slash commands (e.g. /component)
  useEffect(() => {
    if (value.$path) editor.storage.slashCommand.docPath = value.$path;
  }, [editor, value.$path]);

  // Sync editable state
  useEffect(() => {
    if (editor.isEditable !== editable) editor.setEditable(editable);
  }, [editor, editable]);

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
        onDrop={(e) => {
          if (!editor || !onChange) return;
          const path = e.dataTransfer.getData('application/treenity-path');
          if (!path) return;
          e.preventDefault();
          e.stopPropagation();
          editor.chain().focus().insertContent({
            type: 'treenityBlock',
            attrs: { ref: path, type: null, props: {} },
          }).run();
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('application/treenity-path')) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
          }
        }}
      >
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

function parseContent(content: string | undefined): any {
  if (!content) return undefined;
  try {
    return JSON.parse(content);
  } catch {
    return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: content }] }] };
  }
}

export function registerDocViews() {
  register('doc.page', 'react', ({ onChange, ...props }) => DocPageView(props));
  register('doc.page', 'react:edit', DocPageView);
}
