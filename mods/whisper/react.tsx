// Whisper channel view — checklist of transcribed audio notes

import * as React from 'react';
import { getComponent, type NodeData, register } from '@treenx/core';
import { patchNode, type View, useChildren } from '@treenx/react';
import { WhisperChannel, WhisperMeta, WhisperText } from './types';

function transcriptionText(node: NodeData): string {
  const text = getComponent(node, WhisperText);
  if (!text) throw new Error(`Transcription has no text component: ${node.$path}`);
  return text.content;
}

const ChannelView: View<WhisperChannel> = ({ value, ctx }) => {
  const node = ctx!.node;
  const { data: children } = useChildren(ctx!.path, { watchNew: true });
  const checklist = value.checklist;

  const checked = new Set<string>(checklist?.checked ?? []);

  const transcriptions = children.filter(child => child.$type === 'whisper.transcription');
  const items = transcriptions.filter(child => transcriptionText(child) !== '...');
  const processing = transcriptions.filter(child => transcriptionText(child) === '...');

  const toggle = (path: string) => {
    const next = new Set(checked);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    patchNode(node.$path, { 'checklist.checked': [...next] });
  };

  return (
    <div className="node-default-view">
      {items.map(child => {
        const text = transcriptionText(child);
        const name = child.$path.slice(child.$path.lastIndexOf('/') + 1);
        const meta = getComponent(child, WhisperMeta);
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
