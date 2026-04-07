// Inspector — view + edit panel for selected node (Unity-style inspector)
// Shell only: header, rendered view, delegates editing to NodeEditor

import './Inspector.css';
import { Bug, ExternalLink, Pencil, Settings } from 'lucide-react';
import { PathBreadcrumb } from '#components/PathBreadcrumb';
import { Badge } from '#components/ui/badge';
import { Button } from '#components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '#components/ui/dropdown-menu';
import { ScrollArea } from '#components/ui/scroll-area';
import { Render, RenderContext } from '#context';
import { getViewContexts, pickDefaultContext } from '#mods/editor-ui/node-utils';
import { useState } from 'react';
import { ErrorBoundary } from '#app/ErrorBoundary';
import { usePath } from '#hooks';
import { NodeEditor } from './NodeEditor';
import { useAutoSave } from '#tree/auto-save';

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
        <div className="flex items-center gap-2 flex-wrap">
          <h2>{nodeName}</h2>
          <Badge variant="outline" className="font-mono text-[10px]">{node.$type}</Badge>

          <DropdownMenu>
            <DropdownMenuTrigger className="text-[11px] text-muted-foreground hover:text-foreground cursor-pointer transition-colors px-2 py-1">
              <Bug size={12} className="inline" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
              <DropdownMenuLabel className="text-[10px] text-muted-foreground">Render context</DropdownMenuLabel>
              {viewContexts.map((c) => (
                <DropdownMenuItem
                  key={c}
                  onClick={() => setContext(c)}
                  className={context === c ? 'bg-accent font-medium' : ''}
                >
                  {c.startsWith('react:') ? c.slice(6) : c}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              {onSetRoot && (
                <DropdownMenuItem onClick={() => onSetRoot(node.$path)}>
                  Set as root
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <a
            href={`/v${node.$path}`}
            target="_blank"
            rel="noopener"
            className="inline-flex items-center gap-1 text-[11px] text-emerald-400 hover:text-emerald-300 no-underline transition-colors"
          >
            <ExternalLink size={12} className="shrink-0" />
            View
          </a>

          <span className="flex-1" />

          <Button
            variant={context === 'react:edit' ? 'default' : 'ghost'}
            size="sm"
            className="h-6 text-[11px]"
            onClick={() => setContext(context === 'react:edit' ? pickDefaultContext(node.$type) : 'react:edit')}
          >
            <Pencil className="shrink-0 size-3" />
            {context === 'react:edit' ? 'Editing' : 'Edit mode'}
          </Button>

          <Button variant={propsOpen ? 'default' : 'outline'} size="sm" className="h-6 text-[11px] border-emerald-600 text-emerald-400 hover:bg-emerald-950" onClick={() => setPropsOpen(!propsOpen)}>
            <Settings className="shrink-0 size-3" />
            Props
          </Button>
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
        open={propsOpen}
        onClose={() => setPropsOpen(false)}
        onDelete={() => onDelete(node.$path)}
        currentUserId={currentUserId}
        toast={toast}
        onAddComponent={onAddComponent}
      />
    </div>
  );
}
