import type { Editor } from '@tiptap/react';
import {
  Bold,
  Code,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  List,
  ListOrdered,
  Minus,
  Quote,
} from 'lucide-react';

function Btn({ active, onClick, title, children }: {
  active?: boolean; onClick: () => void; title: string; children: React.ReactNode;
}) {
  return (
    <button
      onMouseDown={(e) => { e.preventDefault(); onClick(); }}
      title={title}
      className={`flex items-center justify-center w-7 h-7 rounded transition-colors ${
        active
          ? 'bg-[var(--accent-color)] text-white'
          : 'text-[var(--text-2)] hover:text-[var(--text)] hover:bg-[var(--surface-3)]'
      }`}
    >
      {children}
    </button>
  );
}

function Sep() {
  return <span className="w-px h-4 bg-[var(--border)] mx-1 flex-shrink-0" />;
}

export function Toolbar({ editor }: { editor: Editor }) {
  const sz = 14;
  return (
    <div className="doc-toolbar flex items-center flex-wrap gap-0.5 px-1 py-1 mb-2 border-b border-[var(--border)]">
      <Btn active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} title="Bold (⌘B)">
        <Bold size={sz} />
      </Btn>
      <Btn active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} title="Italic (⌘I)">
        <Italic size={sz} />
      </Btn>
      <Btn active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()} title="Inline code">
        <Code size={sz} />
      </Btn>

      <Sep />

      <Btn active={editor.isActive('heading', { level: 1 })} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} title="Heading 1">
        <Heading1 size={sz} />
      </Btn>
      <Btn active={editor.isActive('heading', { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} title="Heading 2">
        <Heading2 size={sz} />
      </Btn>
      <Btn active={editor.isActive('heading', { level: 3 })} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} title="Heading 3">
        <Heading3 size={sz} />
      </Btn>

      <Sep />

      <Btn active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()} title="Bullet list">
        <List size={sz} />
      </Btn>
      <Btn active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()} title="Ordered list">
        <ListOrdered size={sz} />
      </Btn>
      <Btn active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()} title="Quote">
        <Quote size={sz} />
      </Btn>
      <Btn active={editor.isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCodeBlock().run()} title="Code block">
        <Code2 size={sz} />
      </Btn>

      <Sep />

      <Btn onClick={() => editor.chain().focus().setHorizontalRule().run()} title="Horizontal rule">
        <Minus size={sz} />
      </Btn>
    </div>
  );
}
