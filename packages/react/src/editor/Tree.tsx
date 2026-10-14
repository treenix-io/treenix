import './Tree.css';
import { ConfirmDialog } from '#components/ConfirmDialog';
import { Badge } from '#components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '#components/ui/dropdown-menu';
import { ChevronRightIcon } from 'lucide-react';
import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { usePath } from '#hooks';
import { useTreeSource } from '#tree/tree-source-context';
import type { TreeSource } from '#tree/tree-source';
import type { PresentationNode } from '#tree/presentation';
import { KernelError } from '@treenx/core/errors';

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

function hasMatchingDescendant(source: TreeSource, path: string, filter: string): boolean {
  for (const child of source.getChildrenSnapshot(path).data) {
    if (
      matchesFilter(nodeName(child.$path), child.$type, filter) ||
      hasMatchingDescendant(source, child.$path, filter)
    )
      return true;
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
          <Badge variant="secondary" className="tree-badge" title={fullType}>
            {typeLabel}
          </Badge>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="min-w-[120px]"
          onClick={(e) => e.stopPropagation()}
        >
          <DropdownMenuItem onClick={() => onCreateChild(path)}>+ Add child</DropdownMenuItem>
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
  node,
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
}: Omit<TreeProps, 'roots'> & { path: string; node: PresentationNode; depth: number }) {
  const source = useTreeSource();
  const childrenSnapshot = useSyncExternalStore(
    useCallback((cb: () => void) => source.subscribeChildren(path, cb), [source, path]),
    useCallback(() => source.getChildrenSnapshot(path), [source, path]),
    useCallback(() => source.getChildrenSnapshot(path), [source, path]),
  );
  const childrenNodes = childrenSnapshot.data;

  const rowRef = useRef<HTMLDivElement>(null);
  const [dragOver] = useState<'above' | 'below' | null>(null);

  const name = nodeName(path);
  const isExp = expanded.has(path);
  const allChildren = childrenNodes;
  const knownChildren = showHidden
    ? allChildren
    : allChildren.filter((child) => !nodeName(child.$path).startsWith('_'));
  const showChildren = filter ? knownChildren : isExp ? knownChildren : [];
  const filteredChildren = filter
    ? showChildren.filter(
        (child) =>
          matchesFilter(nodeName(child.$path), child.$type, filter) ||
          hasMatchingDescendant(source, child.$path, filter),
      )
    : showChildren;

  if (filter && !matchesFilter(name, node.$type, filter) && filteredChildren.length === 0) {
    return null;
  }

  const indent = depth * 16 + 6;
  const typeLabel = node.$type.includes('.')
    ? node.$type.slice(node.$type.lastIndexOf('.') + 1)
    : node.$type;
  const canExpand = knownChildren.length > 0 || !loaded.has(path);

  return (
    <div className="tree-node">
      <div
        ref={rowRef}
        className={`tree-row${selected === path ? ' selected' : ''}${depth === 0 ? ' root' : ''}${dragOver === 'above' ? ' tree-drop-above' : ''}${dragOver === 'below' ? ' tree-drop-below' : ''}`}
        style={{ paddingLeft: indent }}
        role="treeitem"
        aria-selected={selected === path}
        aria-expanded={canExpand ? isExp : undefined}
        tabIndex={0}
        onClick={() => onSelect(path)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          onSelect(path);
        }}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('text/plain', path);
          e.dataTransfer.setData('application/treenix-path', path);
          e.dataTransfer.effectAllowed = 'all';
        }}
        // Intra-tree move temporarily disabled — drag still works as a source
        // (e.g. dropping onto FieldLabel / PathForm). Restore by uncommenting.
        // onDragOver={(e) => {
        //   e.preventDefault();
        //   const rect = rowRef.current!.getBoundingClientRect();
        //   const y = e.clientY - rect.top;
        //   setDragOver(y < rect.height / 2 ? 'above' : 'below');
        // }}
        // onDragLeave={() => setDragOver(null)}
        // onDrop={(e) => {
        //   e.preventDefault();
        //   setDragOver(null);
        //   const from = e.dataTransfer.getData('text/plain');
        //   if (from && from !== path && onMove) onMove(from, path);
        // }}
      >
        {canExpand ? (
          <span
            className="tree-toggle"
            role="button"
            aria-label={isExp ? 'Collapse node' : 'Expand node'}
            aria-expanded={isExp}
            onClick={(e) => {
              e.stopPropagation();
              onExpand(path);
            }}
          >
            <ChevronRightIcon className={`tree-chevron${isExp ? ' open' : ''}`} strokeWidth={2} />
          </span>
        ) : (
          <span className="tree-toggle" aria-hidden="true" />
        )}
        <span className="tree-label-wrap">
          <span className="tree-label" title={path}>
            {name}
          </span>
        </span>
        <BadgeMenu
          path={path}
          typeLabel={typeLabel}
          fullType={node.$type}
          onCreateChild={onCreateChild}
          onDelete={onDelete}
        />
      </div>
      {isExp && childrenSnapshot.error !== null && (
        <p role="alert">{childrenSnapshot.error.message}</p>
      )}
      {isExp &&
        childrenSnapshot.errors?.map((copy) => (
          <p key={copy.id} role="alert">
            {copy.error.message}
          </p>
        ))}
      {(isExp || filter) && filteredChildren.length > 0 && (
        <div className="tree-children">
          {filteredChildren.map((c) => (
            <TreeNode
              key={c.$path}
              path={c.$path}
              node={c}
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

/** Root nodes mount exact reads; descendant rows retain the owning parent's admitted copies. */
function RootNode({ path, ...props }: TreeProps & { path: string }) {
  const { data: node, error } = usePath(path);
  if (path === '/local' && error instanceof KernelError && error.code === 'NOT_FOUND') return null;
  if (error !== null) return <p role="alert">{error.message}</p>;
  return node === undefined ? null : <TreeNode path={path} node={node} depth={0} {...props} />;
}

export function Tree(props: TreeProps) {
  return (
    <div className="tree-root" role="tree">
      {props.roots.map((r) => (
        <RootNode key={r} path={r} {...props} />
      ))}
    </div>
  );
}
