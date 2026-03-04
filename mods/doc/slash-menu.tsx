import { MiniTree } from '@treenity/react/mods/editor-ui/form-fields';
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';

export type SlashMenuItem = {
  title: string;
  group: string;
  command: (props: any) => void;
  pickComponent?: boolean;
};

type SlashMenuProps = {
  items: SlashMenuItem[];
  command: (item: any) => void;
  editor: any;
  range: any;
};

export const SlashMenu = forwardRef<any, SlashMenuProps>(({ items, command, editor, range }, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showPicker, setShowPicker] = useState(false);

  useEffect(() => setSelectedIndex(0), [items]);

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }: { event: KeyboardEvent }) => {
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
    if (item.pickComponent) {
      setShowPicker(true);
      return;
    }
    command(item);
  };

  const handlePickNode = (path: string) => {
    setShowPicker(false);
    editor.chain().focus().deleteRange(range).insertContent({
      type: 'treenityBlock',
      attrs: { ref: path, type: null, props: {} },
    }).run();
  };

  if (showPicker) {
    return <MiniTree onSelect={handlePickNode} onClose={() => setShowPicker(false)} />;
  }

  if (!items.length) {
    return (
      <div className="slash-menu">
        <div className="slash-menu-empty">No commands</div>
      </div>
    );
  }

  return (
    <div className="slash-menu">
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
