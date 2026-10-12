import { useEffect, useState, useSyncExternalStore } from 'react';
import { KernelError } from '@treenx/core/errors';
import { W, type Node } from '@treenx/core/kernel/types';
import { Button } from '#components/ui/button';
import { Input } from '#components/ui/input';
import { ResizablePanel } from '#components/ui/resizable';
import { TypePicker } from '#mods/editor-ui/type-picker';
import { useTreeEffects } from '#hooks';
import { moveBefore, parentOf } from '#editor/native-tree-mutations';
import type { NavigateFn } from '#navigate';
import type { NativeMount, NativeSnapshot } from '#tree/native-source';
import { useTreeSource } from '#tree/tree-source-context';
import type { TreeEffects } from '#tree/effects';

interface EditorSidebarProps {
  authed: string;
  root: string;
  selected: string | null;
  onSelect: NavigateFn;
  onSetRoot: (path: string) => void;
  onLogout: () => void;
}
interface Drag { readonly effects: TreeEffects; readonly node: Node }
const LOADING: NativeSnapshot = { phase: 'loading', generations: [], members: [], included: [] };
const subscribeLoading = () => () => {};
const loadingSnapshot = () => LOADING;

/** Own real canonical child coverage for exactly this expanded parent and selected source. */
function NativeChildren({ path, selected, onSelect, filter, drag, onDrag, onError, onCreate }: {
  path: string; selected: string | null; onSelect: NavigateFn; filter: string;
  onCreate: (path: string) => void; drag?: Drag; onDrag: (drag: Drag | undefined) => void; onError: (error: unknown) => void;
}) {
  const source = useTreeSource();
  const effects = useTreeEffects();
  const [owned, setOwned] = useState<{ source: typeof source; path: string; handle: NativeMount }>();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const handle = owned?.source === source && owned.path === path ? owned.handle : undefined;
  const snapshot = useSyncExternalStore(handle?.subscribe ?? subscribeLoading, handle?.getSnapshot ?? loadingSnapshot, loadingSnapshot);

  useEffect(() => {
    if (source.mountSelector === undefined) throw new KernelError('UNAVAILABLE', 'Native tree requires selector coverage');
    const mounted = source.mountSelector({ children: path, sort: [['$order', 1]], window: { limit: 50 } });
    setOwned({ source, path, handle: mounted });
    return () => mounted.dispose();
  }, [source, path]);

  const nodes = snapshot.members.map(copy => {
    if ('error' in copy) throw new KernelError(copy.error.code, copy.error.message);
    return copy.node;
  });

  /** Commit the actual drop source and current target under their loaded revisions. */
  async function drop(target: Node): Promise<void> {
    const kernel = effects.kernel;
    if (kernel === undefined || drag === undefined) throw new KernelError('UNAVAILABLE', 'No owned native drag');
    if (drag.effects !== effects) throw new KernelError('CANCELLED', 'The drag source changed');
    if (drag.node.$id === target.$id) return;
    await kernel.commit(moveBefore(drag.node, target, nodes, snapshot.next === undefined));
    onDrag(undefined);
  }

  /** Canonical removal invalidates every existing subscriber without a local cache mutation. */
  async function remove(node: Node): Promise<void> {
    const kernel = effects.kernel;
    if (kernel === undefined) throw new KernelError('UNAVAILABLE', 'Native removal requires canonical effects');
    await kernel.commit({ changes: [{ op: 'remove', path: node.$path }], expect: { nodes: [{ path: node.$path, rev: node.$rev }] } });
    onSelect(parentOf(node.$path));
  }

  if (snapshot.error !== undefined) return <p role="alert">{snapshot.error.message}</p>;
  if (snapshot.phase === 'loading') return <p>Loading children…</p>;
  return <ul className="space-y-1 pl-3">
    {snapshot.computed?.map(node => <li key={node.$path}><Button onClick={() => onSelect(node.$path)}>{node.$path} · computed</Button></li>)}
    {snapshot.rows?.map(row => <li key={row.key}><pre>{JSON.stringify(row)}</pre></li>)}
    {snapshot.viewErrors?.map(copy => <li key={copy.id} role="alert">{copy.error.code}: {copy.error.message}</li>)}
    {nodes.map((node, index) => {
    const copy = snapshot.members[index];
    if ('error' in copy) throw new KernelError(copy.error.code, copy.error.message);
    if (filter !== '' && !node.$path.includes(filter)) return null;
    const open = expanded.has(node.$id);
    return <li key={node.$id}>
      <div className="flex items-center gap-1" draggable={(copy.bits & W) !== 0}
        onDragStart={() => onDrag({ effects, node })} onDragEnd={() => onDrag(undefined)}
        onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); event.stopPropagation(); void drop(node).catch(onError); }}>
        <Button aria-label={`Expand ${node.$path}`} variant="ghost" onClick={() => setExpanded(previous => {
          const next = new Set(previous); if (open) next.delete(node.$id); else next.add(node.$id); return next;
        })}>{open ? '−' : '+'}</Button>
        <Button variant={selected === node.$path ? 'secondary' : 'ghost'} onClick={() => onSelect(node.$path)}>{node.$path.slice(node.$path.lastIndexOf('/') + 1)}</Button>
        {(copy.bits & W) !== 0 && <Button aria-label={`Create child of ${node.$path}`} onClick={() => onCreate(node.$path)}>Add child</Button>}
        {(copy.bits & W) !== 0 && <Button aria-label={`Remove ${node.$path}`} variant="ghost" onClick={() => { void remove(node).catch(onError); }}>Remove</Button>}
      </div>
      {open && <NativeChildren path={node.$path} selected={selected} onSelect={onSelect} filter={filter} drag={drag} onDrag={onDrag} onError={onError} onCreate={onCreate} />}
    </li>;
  })}{snapshot.next !== undefined && <li><Button onClick={() => handle?.loadMore()}>Load more children</Button></li>}</ul>;
}

/** Native sidebar state and mutations belong to the captured source, never the legacy path cache. */
export function EditorSidebar({ authed, root, selected, onSelect, onSetRoot, onLogout }: EditorSidebarProps) {
  const effects = useTreeEffects();
  const [filter, setFilter] = useState('');
  const [drag, setDrag] = useState<Drag>();
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState<{ effects: TreeEffects; path: string }>();

  /** Surface canonical refusals at the actual editor boundary. */
  function failed(reason: unknown): void { setError(reason instanceof Error ? reason.message : String(reason)); }

  /** Create through the selected canonical owner and let live child coverage publish the new member. */
  async function create(name: string, type: string): Promise<void> {
    if (creating?.effects !== effects) throw new KernelError('CANCELLED', 'The creation source changed');
    const path = creating.path === '/' ? `/${name}` : `${creating.path}/${name}`;
    await effects.createNode(path, type);
    setCreating(undefined);
    onSelect(path);
  }

  return <ResizablePanel defaultSize="28%" minSize="240px" maxSize="450px" className="flex flex-col border-r border-border">
    <div className="flex items-center justify-between p-2"><strong>Treenix · {authed}</strong><Button onClick={onLogout}>Logout</Button></div>
    <Button variant="ghost" onClick={() => onSetRoot('/')}>{root}</Button>
    <Button onClick={() => setCreating({ effects, path: root })}>Add child to {root}</Button>
    <Input aria-label="Search nodes" value={filter} onChange={event => setFilter(event.target.value)} />
    {error !== undefined && <p role="alert">{error}</p>}
    <div className="flex-1 overflow-auto"><NativeChildren key={root} path={root} selected={selected} onSelect={onSelect} filter={filter}
      drag={drag?.effects === effects ? drag : undefined} onDrag={setDrag} onError={failed} onCreate={path => setCreating({ effects, path })} /></div>
    {creating?.effects === effects && <TypePicker onSelect={(name, type) => { void create(name, type).catch(failed); }} onCancel={() => setCreating(undefined)} />}
  </ResizablePanel>;
}
