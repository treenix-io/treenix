import './InspectorHeader.css';
import { PathBreadcrumb } from '#components/PathBreadcrumb';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '#components/ui/dropdown-menu';
import { getViewContexts, pickDefaultContext } from '#mods/editor-ui/node-utils';
import type { NodeData } from '@treenx/core';
import { Bug, ChevronDown, ExternalLink, FileText, PenLine } from 'lucide-react';

type InspectorHeaderProps = {
  node: NodeData;
  context: string;
  propsOpen: boolean;
  onContextChange: (context: string) => void;
  onPropsOpenChange: (open: boolean) => void;
  onSelect: (path: string) => void;
  onSetRoot?: (path: string) => void;
};

function getNodeName(path: string) {
  return path === '/' ? '/' : path.slice(path.lastIndexOf('/') + 1);
}

export function InspectorHeader({
  node,
  context,
  propsOpen,
  onContextChange,
  onPropsOpenChange,
  onSelect,
  onSetRoot,
}: InspectorHeaderProps) {
  const nodeName = getNodeName(node.$path);
  const viewContexts = getViewContexts(node.$type, node);

  return (
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
            {viewContexts.map((viewContext) => {
              const active = context === viewContext;
              return (
                <DropdownMenuItem
                  key={viewContext}
                  onClick={() => onContextChange(viewContext)}
                  className={active ? 'bg-accent text-accent-foreground font-medium' : ''}
                >
                  <span>{viewContext.replace('react:', '')}</span>
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

      <PathBreadcrumb
        path={node.$path}
        onSelect={onSelect}
        className="inspector-path"
        listClassName="inspector-crumb-list"
        itemClassName="inspector-crumb-part"
        linkClassName="inspector-crumb-link"
        pageClassName="inspector-crumb-current"
        separatorClassName="inspector-crumb-separator"
      />

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
            onClick={() => onContextChange(context === 'react:edit' ? pickDefaultContext(node.$type) : 'react:edit')}
          >
            <PenLine className="size-4" />
            Edit
          </button>

          <button
            type="button"
            aria-pressed={propsOpen}
            className="inspector-props-button"
            onClick={() => onPropsOpenChange(!propsOpen)}
          >
            <FileText className="size-4" />
            Props
          </button>
        </div>
      </div>
    </div>
  );
}
