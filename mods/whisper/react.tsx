// Whisper channel view — checklist of transcribed audio notes

import { type NodeData, register } from '@treenx/core';
import { set, type View, useChildren } from '@treenx/react';

const ChannelView: View = ({ value, ctx }) => {
  const node = ctx!.node;
  const { data: children } = useChildren(ctx!.path, { watchNew: true });
  const checklist = value.checklist as { $type: string; checked?: string[] } | undefined;

  const checked = new Set<string>(checklist?.checked ?? []);

  const items = children.filter(c => {
    const text = c.text as { $type: string; content: string } | undefined;
    return text?.$type === 'whisper.text' && text.content && text.content !== '...';
  });

  const processing = children.filter(c => {
    const text = c.text as { $type: string; content: string } | undefined;
    return text?.$type === 'whisper.text' && text.content === '...';
  });

  const toggle = (path: string) => {
    const next = new Set(checked);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    set({ ...node, checklist: { $type: 'whisper.checklist', checked: [...next] } });
  };

  return (
    <div className="node-default-view">
      {items.map(child => {
        const text = (child.text as any).content as string;
        const name = child.$path.slice(child.$path.lastIndexOf('/') + 1);
        const meta = child.meta as { duration?: number } | undefined;
        const done = checked.has(child.$path);

        return (
          <label
            key={child.$path}
            className={`flex gap-2.5 px-3 py-2.5 cursor-pointer border-b border-[var(--border)] ${done ? 'opacity-50' : ''}`}
          >
            <input
              type="checkbox"
              checked={done}
              onChange={() => toggle(child.$path)}
              className="mt-0.5 shrink-0 w-4 h-4 p-0"
            />
            <div className="flex-1">
              <div className={`text-[13px] leading-snug ${done ? 'line-through' : ''}`}>
                {text}
              </div>
              <div className="text-[11px] text-[var(--text-3)] mt-1">
                {name}{meta?.duration ? ` · ${meta.duration}s` : ''}
              </div>
            </div>
          </label>
        );
      })}

      {processing.map(child => {
        const name = child.$path.slice(child.$path.lastIndexOf('/') + 1);
        return (
          <div
            key={child.$path}
            className="px-3 py-2.5 border-b border-[var(--border)] text-[var(--text-3)] text-[13px] italic"
          >
            {name} — transcribing...
          </div>
        );
      })}

      {items.length === 0 && processing.length === 0 && (
        <div className="node-empty">No transcriptions yet</div>
      )}
    </div>
  );
}

register('whisper.channel', 'react', ChannelView);
