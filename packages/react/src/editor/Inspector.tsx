// Inspector — view + edit panel for selected node (Unity-style inspector)
// Shell only: header, rendered view, delegates editing to NodeEditor

import './Inspector.css';
import { ConfirmDialog } from '#components/ConfirmDialog';
import { PathBreadcrumb } from '#components/PathBreadcrumb';
import { Badge } from '#components/ui/badge';
import { Button } from '#components/ui/button';
import { ScrollArea } from '#components/ui/scroll-area';
import { Render, RenderContext } from '#context';
import { getViewContexts, pickDefaultContext } from '#mods/editor-ui/node-utils';
import { useState } from 'react';
import { ErrorBoundary } from '#app/ErrorBoundary';
import { usePath } from '#hooks';
import { useAutoSave } from '#tree/auto-save';
import { NodeEditor } from './NodeEditor';

type Props = {
  path: string | null;
  currentUserId?: string;
  onDelete: (path: string) => void;
  onAddComponent: (path: string) => void;
  onSelect: (path: string) => void;
  onSetRoot?: (path: string) => void;
  toast: (msg: string) => void;
};

export function Inspector({ path, currentUserId, onDelete, onAddComponent, onSelect, onSetRoot, toast }: Props) {
  const node = usePath(path);
  const save = useAutoSave(path ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);
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
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground/40">
          <div className="text-[32px] opacity-30">&#9741;</div>
          <p>Select a node to inspect</p>
        </div>
      </div>
    );
  }

  const nodeName = node.$path === '/' ? '/' : node.$path.slice(node.$path.lastIndexOf('/') + 1);
  const viewContexts = getViewContexts(node.$type, node);

  return (
    <div className="editor">
      {/* Header */}
      <div className="px-6 pt-4 pb-3 border-b border-border bg-card shrink-0">
        <PathBreadcrumb path={node.$path} onSelect={onSelect} />
        <div className="flex items-center gap-2.5 flex-wrap">
          <h2>{nodeName}</h2>
          <Badge variant="outline" className="font-mono text-[10px]">{node.$type}</Badge>
          <a
            href={node.$path}
            target="_blank"
            rel="noopener"
            className="text-[11px] text-muted-foreground hover:text-primary no-underline"
          >
            View &#8599;
          </a>
          {onSetRoot && (
            <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px]" onClick={() => onSetRoot(node.$path)} title="Focus subtree">
              &#8962;
            </Button>
          )}
          {viewContexts.length > 1 && (
            <span className="flex gap-0.5">
              {viewContexts.map((c) => (
                <Button
                  key={c}
                  variant={context === c ? 'default' : 'ghost'}
                  size="sm"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => setContext(c)}
                >
                  {c.replace('react:', '')}
                </Button>
              ))}
            </span>
          )}
          <span className="flex-1" />
          <Button variant={editing ? 'ghost' : 'default'} size="sm" className="h-7" onClick={() => setEditing(!editing)}>
            {editing ? 'Close' : 'Edit'}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="h-7"
            onClick={() => setConfirmDelete(true)}
          >
            Delete
          </Button>
          <ConfirmDialog
            open={confirmDelete}
            onOpenChange={setConfirmDelete}
            title={`Delete ${node.$path}?`}
            description="This action cannot be undone."
            variant="destructive"
            onConfirm={() => onDelete(node.$path)}
          />
        </div>
      </div>

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
        open={editing}
        onClose={() => setEditing(false)}
        currentUserId={currentUserId}
        toast={toast}
        onAddComponent={onAddComponent}
      />
    </div>
  );
}
