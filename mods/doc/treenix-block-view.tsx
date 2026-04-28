import { NodeViewWrapper } from '@tiptap/react';
import { getContextsForType } from '@treenx/core';
import { getRegistryVersion, subscribeRegistry } from '@treenx/core/core/registry';
import { Render, RenderContext } from '@treenx/react';
import { usePath } from '@treenx/react';
import { useAutoSave } from '@treenx/react/tree/auto-save';
import { useEffect, useState, useSyncExternalStore } from 'react';

export function TreenixBlockView({ node, updateAttributes, deleteNode, editor, getPos }: any) {
  const ref = node.attrs.ref as string | null;
  const type = node.attrs.type as string | null;
  const { data: refNode } = usePath(ref);
  const editable = editor?.isEditable;
  const save = useAutoSave(ref ?? '');

  const attrCtx = (node.attrs.context as string | null) ?? 'react';
  const ctx = editable && attrCtx === 'react' ? 'react:edit' : attrCtx;

  // Range selection highlight (not click/NodeSelection)
  const [rangeSelected, setRangeSelected] = useState(false);
  useEffect(() => {
    if (!editor) return;
    const check = () => {
      const pos = typeof getPos === 'function' ? getPos() : -1;
      if (pos === -1) { setRangeSelected(false); return; }
      const { from, to } = editor.state.selection;
      const end = pos + node.nodeSize;
      const covers = from < end && to > pos;
      const isNodeSel = from === pos && to === end;
      setRangeSelected(covers && !isNodeSel);
    };
    editor.on('selectionUpdate', check);
    return () => editor.off('selectionUpdate', check);
  }, [editor, node.nodeSize, getPos]);

  // Re-check available contexts when registry changes (views load asynchronously)
  useSyncExternalStore(subscribeRegistry, getRegistryVersion);

  const effectiveType = refNode?.$type ?? type ?? '';
  const availableContexts = effectiveType
    ? getContextsForType(effectiveType).filter((c) => c.startsWith('react')).sort()
    : [];

  const renderContent = () => {
    if (ref && refNode) {
      return (
        <RenderContext name={ctx}>
          <Render value={refNode} onChange={editable ? save.onChange : undefined} />
        </RenderContext>
      );
    }

    if (ref && !refNode) {
      return (
        <div className="text-sm italic p-4" style={{ color: 'var(--text-3)' }}>
          Loading {ref}…
        </div>
      );
    }

    if (type && node.attrs.props) {
      return (
        <RenderContext name={ctx}>
          <Render value={{ $type: type, ...node.attrs.props }} />
        </RenderContext>
      );
    }

    return (
      <div className="text-sm italic p-4" style={{ color: 'var(--text-3)' }}>
        Empty component block
      </div>
    );
  };

  const label = effectiveType || ref?.split('/').at(-1) || '?';
  const shortLabel = label.includes('.') ? label.slice(label.lastIndexOf('.') + 1) : label;
  const shortCtx = ctx.startsWith('react:') ? ctx.slice(6) : ctx;

  return (
    <NodeViewWrapper className="my-2">
      <div
        className="relative group"
        style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', background: 'var(--surface)' }}
      >
        {editable && (
          <div
            className="absolute top-1 right-1 z-10 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
            contentEditable={false}
          >
            {/* type badge */}
            <span
              className="text-[10px] px-1.5 py-0.5 rounded font-mono"
              style={{ background: 'var(--surface-3)', color: 'var(--text-3)' }}
            >
              {shortLabel}
            </span>

            {/* context switcher — only when multiple react* contexts registered */}
            {availableContexts.length > 1 ? (
              <select
                value={ctx}
                onChange={(e) => updateAttributes({ context: e.target.value })}
                className="text-[10px] rounded px-1 py-0.5 cursor-pointer"
                style={{ background: 'var(--surface-3)', color: 'var(--text-2)', border: 'none' }}
              >
                {availableContexts.map((c) => (
                  <option key={c} value={c}>
                    {c.startsWith('react:') ? c.slice(6) : c}
                  </option>
                ))}
              </select>
            ) : (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded font-mono"
                style={{ background: 'var(--surface-3)', color: 'var(--text-3)' }}
              >
                {shortCtx}
              </span>
            )}

            {/* delete */}
            <button
              onClick={deleteNode}
              className="text-[12px] px-1.5 py-0.5 rounded leading-none cursor-pointer"
              style={{ background: 'var(--surface-3)', color: 'var(--text-3)' }}
            >
              ×
            </button>
          </div>
        )}

        <div contentEditable={false}>{renderContent()}</div>

        {rangeSelected && (
          <div className="absolute inset-0 rounded-[6px] pointer-events-none" style={{ background: 'rgba(46, 204, 113, 0.2)' }} />
        )}
      </div>
    </NodeViewWrapper>
  );
}
