import type { Editor, Range } from '@tiptap/core';
import { createNode, getRegisteredTypes } from '@treenx/core';
import { getDefaults } from '@treenx/core/comp';
import { MiniTree } from '@treenx/react/mods/editor-ui/form-fields';
import { set } from '@treenx/react/hooks';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';

export type SlashMenuItem = {
  title: string;
  group: string;
  command: (props: { editor: Editor; range: Range }) => void;
  picker?: 'ref' | 'component' | 'link';
};

type Props = {
  items: SlashMenuItem[];
  command: (item: SlashMenuItem) => void;
  editor: Editor;
  range: Range;
  docPath: string;
};

function scrollToSelected(container: HTMLDivElement | null, index: number) {
  if (!container) return;
  const el = container.children[index] as HTMLElement | undefined;
  if (!el) return;
  const cRect = container.getBoundingClientRect();
  const eRect = el.getBoundingClientRect();
  if (eRect.top < cRect.top) container.scrollTop += eRect.top - cRect.top;
  else if (eRect.bottom > cRect.bottom) container.scrollTop += eRect.bottom - cRect.bottom;
}

export const SlashMenu = forwardRef<unknown, Props>(({ items, command, editor, range, docPath }, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [pickerMode, setPickerMode] = useState<'ref' | 'component' | 'link' | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => setSelectedIndex(0), [items]);
  useEffect(() => { scrollToSelected(menuRef.current, selectedIndex); }, [selectedIndex]);

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }: { event: KeyboardEvent }) => {
      if (pickerMode) return false;

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedIndex((i) => (i + 1) % items.length);
        return true;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedIndex((i) => (i - 1 + items.length) % items.length);
        return true;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        selectItem(selectedIndex);
        return true;
      }
      return false;
    },
  }));

  const selectItem = (index: number) => {
    const item = items[index];
    if (!item) return;

    if (item.picker) {
      setPickerMode(item.picker);
      return;
    }
    command(item);
  };

  const close = () => {
    setPickerMode(null);
    command({ title: '', group: '', command: () => {} });
  };

  const insertRef = (path: string) => {
    editor.chain().focus().deleteRange(range).insertContent({
      type: 'treenixBlock',
      attrs: { ref: path, type: null, props: {} },
    }).run();
    close();
  };

  const insertLink = (path: string) => {
    const label = path.split('/').filter(Boolean).pop() ?? path;
    editor.chain().focus().deleteRange(range)
      .insertContent({ type: 'text', text: label, marks: [{ type: 'nodeLink', attrs: { path } }] })
      .run();
    close();
  };

  const createComponent = async (typeName: string) => {
    const dp = docPath || editor.storage.slashCommand?.docPath || '';
    if (!dp || !typeName) {
      console.error('[slash] createComponent: no docPath', { docPath, storage: editor.storage.slashCommand });
      close();
      return;
    }

    const short = typeName.includes('.') ? typeName.split('.').pop() : typeName;
    const childPath = `${dp}/${short}-${Date.now().toString(36)}`;

    try {
      const node = createNode(childPath, typeName, getDefaults(typeName));
      await set(node);
      editor.chain().focus().deleteRange(range).insertContent({
        type: 'treenixBlock',
        attrs: { ref: childPath, type: null, props: {} },
      }).run();
    } catch (err) {
      console.error('[slash] createComponent failed:', err);
    }
    close();
  };

  if (pickerMode === 'ref') {
    return (
      <div className="slash-picker">
        <div className="slash-picker-header">Embed existing node</div>
        <MiniTree onSelect={insertRef} />
      </div>
    );
  }

  if (pickerMode === 'link') {
    return (
      <div className="slash-picker">
        <div className="slash-picker-header">Link to node</div>
        <MiniTree onSelect={insertLink} />
      </div>
    );
  }

  if (pickerMode === 'component') {
    return <TypePicker onSelect={createComponent} />;
  }

  if (!items.length) {
    return (
      <div className="slash-menu">
        <div className="slash-menu-empty">No commands</div>
      </div>
    );
  }

  return (
    <div className="slash-menu" ref={menuRef}>
      {items.map((item, i) => (
        <button
          key={item.title}
          onMouseDown={(e) => { e.preventDefault(); selectItem(i); }}
          className={`slash-menu-item${i === selectedIndex ? ' selected' : ''}`}
        >
          <span className="slash-menu-title">{item.title}</span>
          <span className="slash-menu-group">{item.group}</span>
        </button>
      ))}
    </div>
  );
});

SlashMenu.displayName = 'SlashMenu';

/* ── Type picker for /component ── */

function TypePicker({ onSelect }: { onSelect: (type: string) => void }) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const allTypes = useMemo(() => getRegisteredTypes('react').sort(), []);

  const filtered = useMemo(() => {
    if (!query) return allTypes;
    const q = query.toLowerCase();
    return allTypes.filter((t) => t.toLowerCase().includes(q));
  }, [allTypes, query]);

  useEffect(() => setSelectedIndex(0), [filtered]);
  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => { scrollToSelected(listRef.current, selectedIndex); }, [selectedIndex]);

  const confirm = () => {
    const selected = filtered[selectedIndex];
    if (selected) onSelect(selected);
    else if (query.trim()) onSelect(query.trim());
  };

  return (
    <div className="slash-picker">
      <div className="slash-picker-header">New component</div>
      <div className="slash-picker-input-wrap">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSelectedIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              confirm();
            }
          }}
          placeholder="Type name…"
          className="slash-picker-input"
        />
      </div>
      <div className="slash-picker-list" ref={listRef}>
        {filtered.slice(0, 20).map((t, i) => (
          <button
            key={t}
            onMouseDown={(e) => { e.preventDefault(); onSelect(t); }}
            className={`slash-menu-item${i === selectedIndex ? ' selected' : ''}`}
          >
            <span className="slash-menu-title">{t}</span>
          </button>
        ))}
        {filtered.length === 0 && query.trim() && (
          <button
            onMouseDown={(e) => { e.preventDefault(); onSelect(query.trim()); }}
            className="slash-menu-item selected"
          >
            <span className="slash-menu-title">Create &ldquo;{query.trim()}&rdquo;</span>
          </button>
        )}
      </div>
    </div>
  );
}
