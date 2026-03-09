import './Tree.css';
import { ConfirmDialog } from '#components/ConfirmDialog';
import { Badge } from '#components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '#components/ui/dropdown-menu';
import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import * as cache from './cache';

type TreeProps = {
  roots: string[];
  expanded: Set<string>;
  loaded: Set<string>;
  selected: string | null;
  filter: string;
  showHidden: boolean;
  onSelect: (path: string) => void;
  onExpand: (path: string) => void;
  onCreateChild: (parentPath: string) => void;
  onDelete?: (path: string) => void;
  onMove?: (fromPath: string, toPath: string) => void;
};

function nodeName(p: string) {
  return p.slice(p.lastIndexOf('/') + 1) || '/';
}

function matchesFilter(name: string, type: string, filter: string): boolean {
  if (!filter) return true;
  const lf = filter.toLowerCase();
  return name.toLowerCase().includes(lf) || type.toLowerCase().includes(lf);
}

function hasMatchingDescendant(path: string, filter: string): boolean {
  const nodes = cache.raw();
  const prefix = path === '/' ? '/' : path + '/';
  for (const [k, v] of nodes) {
    if (k.startsWith(prefix) && matchesFilter(nodeName(k), v.$type, filter)) return true;
  }
  return false;
}

function BadgeMenu({
  path,
  typeLabel,
  fullType,
  onCreateChild,
  onDelete,
}: {
  path: string;
  typeLabel: string;
  fullType: string;
  onCreateChild: (path: string) => void;
  onDelete?: (path: string) => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
          <Badge
            variant="secondary"
            className="tree-badge cursor-pointer text-[10px] px-1.5 py-0 h-5 font-mono font-normal"
            title={fullType}
          >
            {typeLabel}
          </Badge>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[120px]" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuItem onClick={() => onCreateChild(path)}>
            + Add child
          </DropdownMenuItem>
          {onDelete && (
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => setConfirmDelete(true)}
            >
              × Delete
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {onDelete && (
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title={`Delete ${path}?`}
          description="This action cannot be undone."
          variant="destructive"
          onConfirm={() => onDelete(path)}
        />
      )}
    </>
  );
}

function TreeNode({
  path,
  expanded,
  loaded = new Set<string>(),
  selected,
  filter,
  showHidden,
  depth,
  onSelect,
  onExpand,
  onCreateChild,
  onDelete,
  onMove,
}: Omit<TreeProps, 'roots'> & { path: string; depth: number }) {
  // Granular subscriptions — only re-render when THIS node or ITS children change
  const node = useSyncExternalStore(
    useCallback((cb: () => void) => cache.subscribePath(path, cb), [path]),
    useCallback(() => cache.get(path), [path]),
  );
  const childrenNodes = useSyncExternalStore(
    useCallback((cb: () => void) => cache.subscribeChildren(path, cb), [path]),
    useCallback(() => cache.getChildren(path), [path]),
  );

  const rowRef = useRef<HTMLDivElement>(null);
  const [dragOver, setDragOver] = useState<'above' | 'below' | null>(null);

  if (!node) return null;

  const name = nodeName(path);
  const isExp = expanded.has(path);
  const allChildren = childrenNodes.map(n => n.$path).filter(p => p !== path);
  const knownChildren = showHidden
    ? allChildren
    : allChildren.filter(p => !nodeName(p).startsWith('_'));
  const showChildren = filter ? knownChildren : isExp ? knownChildren : [];
  const filteredChildren = filter
    ? showChildren.filter((c) => {
        const cn = cache.get(c);
        if (!cn) return false;
        return matchesFilter(nodeName(c), cn.$type, filter) || hasMatchingDescendant(c, filter);
      })
    : showChildren;

  if (filter && !matchesFilter(name, node.$type, filter) && filteredChildren.length === 0) {
    return null;
  }

  const indent = depth * 12 + 4;
  const typeLabel = node.$type.includes('.') ? node.$type.slice(node.$type.lastIndexOf('.') + 1) : node.$type;

  return (
    <div className="tree-node">
      <div
        ref={rowRef}
        className={`tree-row${selected === path ? ' selected' : ''}${dragOver === 'above' ? ' tree-drop-above' : ''}${dragOver === 'below' ? ' tree-drop-below' : ''}`}
        style={{ paddingLeft: indent }}
        onClick={() => onSelect(path)}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('text/plain', path);
          e.dataTransfer.setData('application/treenity-path', path);
          e.dataTransfer.effectAllowed = 'all';
        }}
        onDragOver={(e) => {
          e.preventDefault();
          const rect = rowRef.current!.getBoundingClientRect();
          const y = e.clientY - rect.top;
          setDragOver(y < rect.height / 2 ? 'above' : 'below');
        }}
        onDragLeave={() => setDragOver(null)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(null);
          const from = e.dataTransfer.getData('text/plain');
          if (from && from !== path && onMove) onMove(from, path);
        }}
      >
        {knownChildren.length > 0 || !loaded.has(path) ? (
          <span
            className="tree-toggle"
            onClick={(e) => {
              e.stopPropagation();
              onExpand(path);
            }}
          >
            {isExp ? '\u25BE' : '\u25B8'}
          </span>
        ) : (
          <span className="tree-toggle" />
        )}
        <span className="tree-label">{name}</span>
        <BadgeMenu
          path={path}
          typeLabel={typeLabel}
          fullType={node.$type}
          onCreateChild={onCreateChild}
          onDelete={onDelete}
        />
      </div>
      {(isExp || filter) && filteredChildren.length > 0 && (
        <div className="tree-children">
          {filteredChildren.map((c) => (
            <TreeNode
              key={c}
              path={c}
              depth={depth + 1}
              expanded={expanded}
              loaded={loaded}
              selected={selected}
              filter={filter}
              showHidden={showHidden}
              onSelect={onSelect}
              onExpand={onExpand}
              onCreateChild={onCreateChild}
              onDelete={onDelete}
              onMove={onMove}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function Tree(props: TreeProps) {
  return (
    <div>
      {props.roots.map((r) => (
        <TreeNode key={r} path={r} depth={0} {...props} />
      ))}
    </div>
  );
}
