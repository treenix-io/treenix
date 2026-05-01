// Inspector — view + edit panel for selected node (Unity-style inspector)
// Shell only: header, rendered view, delegates editing to NodeEditor

import './Inspector.css';
import { ErrorBoundary } from '#app/ErrorBoundary';
import { ScrollArea } from '#components/ui/scroll-area';
import { Render, RenderContext } from '#context';
import { usePath } from '#hooks';
import { pickDefaultContext } from '#mods/editor-ui/node-utils';
import { useAutoSave } from '#tree/auto-save';
import { useState } from 'react';
import { InspectorHeader } from './InspectorHeader';
import { NodeEditor } from './NodeEditor';

type Props = {
  path: string | null;
  currentUserId?: string;
  onDelete: (path: string) => void;
  onAddComponent: (path: string) => void;
  onSelect: (path: string) => void;
  onSetRoot?: (path: string) => void;
};

export function Inspector({ path, currentUserId, onDelete, onAddComponent, onSelect, onSetRoot }: Props) {
  const { data: node } = usePath(path);
  const save = useAutoSave(path ?? '');
  const [propsOpen, setPropsOpen] = useState(false);
  const [context, setContext] = useState('react:layout');

  // Reset context when path changes
  const [prevPath, setPrevPath] = useState(path);
  if (path !== prevPath) {
    setPrevPath(path);
    if (node) setContext(pickDefaultContext(node.$type));
  }

  if (!node) {
    return (
      <div className="flex flex-1 flex-col overflow-hidden bg-background">
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground/50">
          <div className="text-[32px] opacity-30">&#9741;</div>
          <p className="text-[12px]">Select a node to inspect</p>
        </div>
      </div>
    );
  }

  return (
    <div className="editor">
      <InspectorHeader
        node={node}
        context={context}
        propsOpen={propsOpen}
        onContextChange={setContext}
        onPropsOpenChange={setPropsOpen}
        onSelect={onSelect}
        onSetRoot={onSetRoot}
      />

      {/* Rendered view */}
      <ScrollArea className="flex-1">
        <div className="p-4">
          <ErrorBoundary key={node.$path}>
            <RenderContext name={context}>
              <div className="node-view">
                <Render value={node} onChange={save.onChange} />
              </div>
            </RenderContext>
          </ErrorBoundary>
        </div>
      </ScrollArea>

      {/* Slide-out edit panel */}
      <NodeEditor
        node={node}
        save={save}
        open={propsOpen}
        onClose={() => setPropsOpen(false)}
        onDelete={() => onDelete(node.$path)}
        currentUserId={currentUserId}
        onAddComponent={onAddComponent}
      />
    </div>
  );
}
