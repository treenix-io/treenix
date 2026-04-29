import type { Editor } from '@tiptap/react';
import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

function copyText(text: string) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
  return Promise.resolve();
}

function CodeCopyButton({ block }: { block: HTMLPreElement }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  return (
    <button
      type="button"
      className="doc-code-copy"
      title={copied ? 'Copied' : 'Copy code'}
      aria-label={copied ? 'Copied' : 'Copy code'}
      contentEditable={false}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void copyText(block.querySelector('code')?.textContent ?? '').then(() => {
          setCopied(true);
          if (timerRef.current !== null) window.clearTimeout(timerRef.current);
          timerRef.current = window.setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

export function CodeCopyButtons({
  editor,
  enabled,
  contentVersion,
}: {
  editor: Editor;
  enabled: boolean;
  contentVersion: unknown;
}) {
  const [blocks, setBlocks] = useState<HTMLPreElement[]>([]);

  useEffect(() => {
    if (!enabled) {
      setBlocks([]);
      return;
    }

    let mountedBlocks: HTMLPreElement[] = [];
    const frame = window.requestAnimationFrame(() => {
      mountedBlocks = Array.from(editor.view.dom.querySelectorAll<HTMLPreElement>('pre'))
        .filter((block) => block.querySelector('code'));
      mountedBlocks.forEach((block) => block.classList.add('doc-code-copyable'));
      setBlocks(mountedBlocks);
    });

    return () => {
      window.cancelAnimationFrame(frame);
      mountedBlocks.forEach((block) => block.classList.remove('doc-code-copyable'));
    };
  }, [contentVersion, editor, enabled]);

  if (!enabled) return null;

  return blocks.map((block, index) => (
    createPortal(<CodeCopyButton block={block} />, block, index)
  ));
}
