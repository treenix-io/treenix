// Editor shell view — registered for t.editor.shell. Rendered by Router when
// /sys/routes/t resolves. The route node's `route` component (prefix/index)
// drives target path resolution; ?root= selects the sidebar root and is
// preserved across navigations via useRouteShell's preserveQuery.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  addComponent,
  cache,
  NavigateProvider,
  setEditorRoot,
  tree,
  useLocation,
  type View,
  view,
} from '@treenx/react';
import { useRouteShell } from '@treenx/react/router/use-route-shell';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@treenx/react/ui/resizable';
import { useAuthContext } from '@treenx/react/app/auth-context';
import { EMPTY, RouteParamsContext, useRouteParams } from '@treenx/react/context/route-params';
import { ConnectionBanner } from '@treenx/react/app/ConnectionBanner';
import { EditorSidebar } from '@treenx/react/app/EditorSidebar';
import { LoginScreen } from '@treenx/react/app/Login';
import { Inspector } from '@treenx/react/editor/Inspector';
import { useModErrors } from '@treenx/react/hooks/use-mod-errors';
import { TypePicker } from '@treenx/react/mods/editor-ui/type-picker';
import { EditorShell } from './types';

const EditorShellView: View<EditorShell> = ({ ctx }) => {
  const { authed, authChecked, setAuthed, logout } = useAuthContext();
  const { search } = useLocation();

  const { target: selected, nav } = useRouteShell(ctx!.node, { preserveQuery: { root: '/' } });
  const root = useMemo(
    () => new URLSearchParams(search).get('root') || '/',
    [search],
  );

  const [addingComponentAt, setAddingComponentAt] = useState<string | null>(null);
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
      const msg = (e.reason as { message?: string } | null)?.message ?? String(e.reason);
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
      nav(parent ?? '/');
    },
    [nav],
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

  const handleSetRoot = useCallback(
    (newRoot: string) => { setEditorRoot(newRoot, selected); },
    [selected],
  );

  if (!authChecked) return null;
  if (!authed) return <LoginScreen onLogin={setAuthed} />;

  return (
    <RouteParamsContext value={EMPTY}>
    <NavigateProvider value={nav}>
      <ConnectionBanner />
      <div className="flex h-screen bg-background text-foreground overflow-hidden">
        <ResizablePanelGroup orientation="horizontal" className="h-full">
          <EditorSidebar
            authed={authed}
            root={root}
            selected={selected}
            onSelect={nav}
            onSetRoot={handleSetRoot}
            onLogout={logout}
          />

          <ResizableHandle withHandle />

          <ResizablePanel defaultSize={72} minSize={40}>
            <Inspector
              path={selected}
              currentUserId={authed}
              onDelete={handleDelete}
              onAddComponent={handleAddComponent}
              onSelect={nav}
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
      </div>
    </NavigateProvider>
    </RouteParamsContext>
  );
};

view(EditorShell, EditorShellView);
