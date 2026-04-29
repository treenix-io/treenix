// Inspector — view + edit panel for selected node (Unity-style inspector)
// Shell only: header, rendered view, delegates editing to NodeEditor

import './Inspector.css';
import { ErrorBoundary } from '#app/ErrorBoundary';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '#components/ui/dropdown-menu';
import { ScrollArea } from '#components/ui/scroll-area';
import { Render, RenderContext } from '#context';
import { usePath } from '#hooks';
import { getViewContexts, pickDefaultContext } from '#mods/editor-ui/node-utils';
import { useAutoSave } from '#tree/auto-save';
import { Bug, ChevronDown, ChevronRight, ExternalLink, FileText, PenLine } from 'lucide-react';
import { useState } from 'react';
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

  const nodeName = node.$path === '/' ? '/' : node.$path.slice(node.$path.lastIndexOf('/') + 1);
  const viewContexts = getViewContexts(node.$type, node);
  const crumbs = (() => {
    const parts = node.$path.split('/').filter(Boolean);
    const pathCrumbs: { label: string; path: string }[] = [{ label: 'root', path: '/' }];
    let cur = '';
    for (const part of parts) {
      cur += '/' + part;
      pathCrumbs.push({ label: part, path: cur });
    }
    return pathCrumbs;
  })();

  return (
    <div className="editor">
      {/* Header */}
      <div className="inspector-topbar">
        <div className="inspector-spine" />
        <div className="inspector-identity-wrap">
          <div className="inspector-id-stack">
            <div className="inspector-id-title-row">
              <span className="inspector-id-title">{nodeName}</span>
            </div>
            <div className="inspector-id-kind">{node.$type}</div>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger className="inspector-switcher" title="Switch node">
              <ChevronDown className="size-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="inspector-debug-menu">
              <DropdownMenuLabel className="inspector-menu-label">
                <Bug className="size-3" />
                Render context
              </DropdownMenuLabel>
              {viewContexts.map((c) => {
                const active = context === c;
                return (
                  <DropdownMenuItem
                    key={c}
                    onClick={() => setContext(c)}
                    className={active ? 'bg-accent text-accent-foreground font-medium' : ''}
                  >
                    <span>{c.replace('react:', '')}</span>
                    {active && <span className="ml-auto text-[10px] uppercase text-primary">active</span>}
                  </DropdownMenuItem>
                );
              })}
              {onSetRoot && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => onSetRoot(node.$path)}>
                    Set as root
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="inspector-path" aria-label="Node path">
          {crumbs.map((crumb, index) => {
            const last = index === crumbs.length - 1;
            return (
              <span key={crumb.path} className="inspector-crumb-part">
                {index > 0 && <ChevronRight className="inspector-crumb-separator" />}
                {last ? (
                  <span className="inspector-crumb-current">{crumb.label}</span>
                ) : (
                  <button type="button" className="inspector-crumb-link" onClick={() => onSelect(crumb.path)}>
                    {crumb.label}
                  </button>
                )}
              </span>
            );
          })}
        </div>

        <div className="inspector-toolbar">
          <a
            href={`/v${node.$path}`}
            target="_blank"
            rel="noopener"
            className="inspector-icon-action"
            title="Open view"
          >
            <ExternalLink className="size-4" />
          </a>

          <div className="inspector-segment">
            <button
              type="button"
              aria-pressed={context === 'react:edit'}
              className="inspector-mode-button"
              onClick={() => setContext(context === 'react:edit' ? pickDefaultContext(node.$type) : 'react:edit')}
            >
              <PenLine className="size-4" />
              Edit
            </button>

            <button
              type="button"
              aria-pressed={propsOpen}
              className="inspector-props-button"
              onClick={() => setPropsOpen(!propsOpen)}
            >
              <FileText className="size-4" />
              Props
            </button>
          </div>
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
