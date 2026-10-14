import { TooltipProvider } from './src/components/ui/tooltip';
import { createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Node } from '@treenx/core/kernel/types';
import { usePath, useTreeEffects } from './src/hooks';
import { createLanePersistence } from './src/tree/lane-idb';
import { createLaneSession } from './src/tree/lane-session';
import { LaneSessionProvider } from './src/app/LaneSessionProvider';
import { NodeEditor } from './src/editor/NodeEditor';
import { EditorSidebar } from './src/app/EditorSidebar';
import { ResizablePanel, ResizablePanelGroup } from './src/components/ui/resizable';
import { clientModules } from './src/mods/clients';
import { publishClientExports } from './src/context/client-registry';
import './src/native/style.css';
import { Render } from './src/context';

publishClientExports({ clientModules });
const server = new URLSearchParams(location.search).get('server');
if (server === null) throw new Error('Technical server address is required');
const session = createLaneSession(
  server,
  createLanePersistence(`technical-editor-${crypto.randomUUID()}`),
);

/** Exercise the actual public editor against a genuine authenticated HTTP lane. */
function Editor() {
  const effects = useTreeEffects();
  const [selected, setSelected] = useState('/document');
  const { data: node, error } = usePath<Node>(selected);
  const [failure, setFailure] = useState<string>();
  const state = session.getSnapshot();

  /** Show an actual effect refusal at its caller. */
  function failed(reason: unknown): void {
    setFailure(reason instanceof Error ? reason.message : String(reason));
  }

  return createElement(
    'main',
    { className: 'h-screen flex flex-col' },
    createElement(
      'div',
      { className: 'flex gap-3 p-2' },
      createElement(
        'button',
        {
          onClick: () => {
            void session.login('/admin', 'technical-editor-password').catch(failed);
          },
        },
        'Admit admin',
      ),
      createElement(
        'button',
        {
          onClick: () => {
            void session.anonymous().catch(failed);
          },
        },
        'Admit anonymous',
      ),
      createElement('button', { onClick: () => setSelected('/document') }, 'Show document'),
      createElement('button', { onClick: () => setSelected('/draft') }, 'Show draft'),
      createElement(
        'button',
        { onClick: () => setSelected('/sys/types/test.technical-counter') },
        'Show type owner',
      ),
      createElement(
        'button',
        { onClick: () => setSelected('/uix-tools') },
        'Show agent draft tool',
      ),
      createElement(
        'p',
        { role: 'status' },
        `${state.status} · bits ${String(effects.bits(selected))}`,
      ),
    ),
    failure === undefined ? null : createElement('p', { role: 'alert' }, failure),
    error === null ? null : createElement('p', { role: 'alert' }, error.message),
    createElement(ResizablePanelGroup, {
      orientation: 'horizontal',
      children: [
        createElement(EditorSidebar, {
          key: 'sidebar',
          authed: state.status === 'ready' ? 'ready' : '',
          root: '/folder',
          selected,
          onSelect(path) {
            setSelected(path);
            return true;
          },
          onSetRoot() {},
          onLogout() {
            void session.anonymous().catch(failed);
          },
        }),
        createElement(ResizablePanel, {
          key: 'editor',
          children:
            node === undefined
              ? createElement('p', null, 'No selected node')
              : createElement(
                  'div',
                  null,
                  createElement(NodeEditor, { node, open: true, onClose() {} }),
                  createElement(
                    'section',
                    { 'aria-label': 'Rendered current view' },
                    createElement(Render, { value: node }),
                  ),
                ),
        }),
      ],
    }),
  );
}

const target = document.getElementById('root');
if (target === null) throw new Error('Technical root is absent');
createRoot(target).render(
  createElement(LaneSessionProvider, {
    session,
    children: createElement(TooltipProvider, { children: createElement(Editor) }),
  }),
);
