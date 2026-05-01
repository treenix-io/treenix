// Editor — tree inspector + per-node Inspector at /t/<path>?root=<root>.
// URL is the single source of truth: `selected` and `root` are derived from useLocation.
// Navigation goes through the unified NavigateProvider mounted in Router.

import { Button } from '#components/ui/button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '#components/ui/resizable';
import { TypePicker } from '#mods/editor-ui/type-picker';
import type { NodeData } from '@treenx/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import * as cache from '#tree/cache';
import { tree } from '#tree/client';
import { addComponent } from '#hooks';
import { setEditorRoot, useLocation, useNavigate } from '#navigate';
import { EditorSidebar } from './EditorSidebar';
import { Inspector } from '#editor/Inspector';
import { toast } from 'sonner';
import { useSseStatus } from '#hooks/use-sse-status';
import { useModErrors } from '#hooks/use-mod-errors';
import { ConnectionBanner } from './ConnectionBanner';
import { CreateRootDialog } from './CreateRootDialog';

export interface EditorProps {
  authed: string;
  onLogout: () => void;
}

export function Editor({ authed, onLogout }: EditorProps) {
  const { pathname, search } = useLocation();
  const selected = useMemo(
    () => (pathname.startsWith('/t') ? (pathname.slice(2) || '/') : null),
    [pathname],
  );
  const root = useMemo(
    () => new URLSearchParams(search).get('root') || '/',
    [search],
  );
  const navigate = useNavigate();

  const [error, setError] = useState<string | null>(null);
  const [addingComponentAt, setAddingComponentAt] = useState<string | null>(null);
  const [rootPromptOpen, setRootPromptOpen] = useState(false);
  const sseDown = useSseStatus();
  useModErrors();

  // Cmd+/ : open Add Component picker for the currently selected node
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      if (document.querySelector('[data-slot="dialog-overlay"]')) return;
      if (e.key === '/' && selected) {
        e.preventDefault();
        setAddingComponentAt(selected);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selected]);

  // Surface uncaught promise rejections as toasts so users see fetch/tree errors.
  useEffect(() => {
    const handler = (e: PromiseRejectionEvent) => {
      const msg = e.reason?.message || String(e.reason);
      toast.error(msg);
    };
    window.addEventListener('unhandledrejection', handler);
    return () => window.removeEventListener('unhandledrejection', handler);
  }, []);

  const handleDelete = useCallback(
    async (path: string) => {
      await tree.remove(path);
      cache.remove(path);
      const parent = path === '/' ? null : path.slice(0, path.lastIndexOf('/')) || '/';
      if (parent) {
        const { items: children } = await tree.getChildren(parent, { watch: true, watchNew: true });
        cache.replaceChildren(parent, children);
      }
      navigate(parent ?? '/');
    },
    [navigate],
  );

  const handleAddComponent = useCallback((path: string) => {
    setAddingComponentAt(path);
  }, []);

  const handlePickComponent = useCallback(
    async (name: string, type: string) => {
      const path = addingComponentAt;
      if (!path) return;
      setAddingComponentAt(null);
      await addComponent(path, name, type);
      toast.success(`Added ${name}`);
    },
    [addingComponentAt],
  );

  const handleCreateRoot = useCallback(async (type: string) => {
    if (!type) return;
    try {
      await tree.set({ $path: '/', $type: type } as NodeData);
      const rootNode = await tree.get('/');
      if (rootNode) cache.put(rootNode);
      navigate('/');
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create root');
    }
  }, [navigate]);

  const handleSetRoot = useCallback(
    (newRoot: string) => { setEditorRoot(newRoot, selected); },
    [selected],
  );

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="text-4xl">&#9888;</span>
          <p className="text-sm text-red-400">{error}</p>
          <Button variant="outline" size="sm" onClick={() => location.reload()}>Retry</Button>
        </div>
      </div>
    );
  }

  return (
    <>
      <ConnectionBanner down={sseDown} />
      <div className="flex h-screen bg-background text-foreground overflow-hidden">
        <ResizablePanelGroup orientation="horizontal" className="h-full">
          <EditorSidebar
            authed={authed}
            root={root}
            selected={selected}
            onSelect={navigate}
            onSetRoot={handleSetRoot}
            onRequestCreateRoot={() => setRootPromptOpen(true)}
            onLogout={onLogout}
          />

          <ResizableHandle withHandle />

          <ResizablePanel defaultSize={72} minSize={40}>
            <Inspector
              path={selected}
              currentUserId={authed}
              onDelete={handleDelete}
              onAddComponent={handleAddComponent}
              onSelect={navigate}
              onSetRoot={handleSetRoot}
            />
          </ResizablePanel>
        </ResizablePanelGroup>

        {addingComponentAt && (
          <TypePicker
            title="Add Component"
            nameLabel="Component name"
            action="Add"
            autoName
            onSelect={handlePickComponent}
            onCancel={() => setAddingComponentAt(null)}
          />
        )}

        <CreateRootDialog
          open={rootPromptOpen}
          onOpenChange={setRootPromptOpen}
          onCreate={handleCreateRoot}
        />
      </div>
    </>
  );
}
