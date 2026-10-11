// Editor shell view — registered for t.editor.shell. Rendered by Router when
// /sys/routes/t resolves. The route node's `route` component (prefix/index)
// drives target path resolution; ?root= selects the sidebar root and is
// preserved across navigations via useRouteShell's preserveQuery.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { compKey, getDefaults } from '@treenx/core';
import { KernelError } from '@treenx/core/errors';
import {
  addComponent,
  removeNode,
  refreshChildren,
  useTreeEffects,
  NavigateProvider,
  setEditorRoot,
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
import { Inspector } from '@treenx/react/editor/Inspector';
import { useModErrors } from '@treenx/react/hooks/use-mod-errors';
import { TypePicker } from '@treenx/react/mods/editor-ui/type-picker';
import { EditorShell } from './types';

const EditorShellView: View<EditorShell> = ({ ctx }) => {
  const { authed, logout } = useAuthContext();
  const effects = useTreeEffects();
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
      const kernel = effects.kernel;
      if (kernel === undefined) await removeNode(path);
      else {
        const copy = (await kernel.read({ node: path })).copies[0];
        if ('error' in copy) throw new KernelError(copy.error.code, copy.error.message);
        await kernel.commit({ changes: [{ op: 'remove', path }],
          expect: { nodes: [{ path, rev: copy.node.$rev }] } });
      }
      const parent = path === '/' ? null : path.slice(0, path.lastIndexOf('/')) || '/';
      if (parent && effects.kernel === undefined) {
        refreshChildren(parent);
      }
      nav(parent ?? '/');
    },
    [nav, effects],
  );

  const handleAddComponent = useCallback((path: string) => {
    setAddingComponentAt(path);
  }, []);

  const handlePickComponent = useCallback(
    async (name: string, type: string) => {
      const path = addingComponentAt;
      if (!path) return;
      setAddingComponentAt(null);
      const kernel = effects.kernel;
      if (kernel === undefined) await addComponent(path, name, type);
      else {
        const copy = (await kernel.read({ node: path })).copies[0];
        if ('error' in copy) throw new KernelError(copy.error.code, copy.error.message);
        const description = await effects.execute(`/sys/types/${type}`, 'describe_type', {}, 't.type');
        const defaults: Record<string, unknown> = {};
        for (const [field, schema] of Object.entries(description.schema.properties ?? {}))
          if (Object.hasOwn(schema, 'default')) defaults[field] = structuredClone(schema.default);
        await kernel.commit({ changes: [{ op: 'patch', path, ops: { $set: {
          [compKey(name)]: { ...getDefaults(type), ...defaults, $type: type, $v: description.version },
        } } }], expect: { nodes: [{ path, rev: copy.node.$rev }] } });
      }
      toast.success(`Added ${name}`);
    },
    [addingComponentAt, effects],
  );

  const handleSetRoot = useCallback(
    (newRoot: string) => { setEditorRoot(newRoot, selected); },
    [selected],
  );

  return (
    <RouteParamsContext value={EMPTY}>
    <NavigateProvider value={nav}>
      <ConnectionBanner />
      <div className="flex h-screen bg-background text-foreground overflow-hidden">
        <ResizablePanelGroup orientation="horizontal" className="h-full">
          <EditorSidebar
            authed={authed!}
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
              currentUserId={authed!}
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
