import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '#components/ui/alert-dialog';
import { Button } from '#components/ui/button';
import { Input } from '#components/ui/input';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '#components/ui/resizable';
import { TypePicker } from '#mods/editor-ui/type-picker';
import type { NodeData } from '@treenx/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as cache from '#tree/cache';
import { tree } from '#tree/client';
import { SSE_CONNECTED, SSE_DISCONNECTED } from '#tree/events';
import { addComponent } from '#hooks';
import { checkBeforeNavigate, makeNavigateApi, NavigateProvider, pushHistory } from '#navigate';
import { EditorSidebar } from './EditorSidebar';
import { Inspector } from '#editor/Inspector';
import { trpc } from '#tree/trpc';
import { getModErrors } from '#tree/load-client';
import { toast } from 'sonner';

export interface EditorProps {
  authed: string;
  onLogout: () => void;
}

export function Editor({ authed, onLogout }: EditorProps) {
  const [root, setRoot] = useState<string>(() =>
    new URLSearchParams(location.search).get('root') || '/',
  );

  const [selected, setSelected] = useState<string | null>(() => {
    const p = location.pathname;
    if (!p.startsWith('/t')) return null;
    const rest = p.slice(2);
    return rest || '/';
  });
  const [error, setError] = useState<string | null>(null);
  const [addingComponentAt, setAddingComponentAt] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [sseDown, setSseDown] = useState(false);
  const sseDownTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Notify about failed mods once
  useEffect(() => {
    const errors = getModErrors();
    if (!errors.size) return;
    for (const [name, msg] of errors) {
      toast.warning(`Mod "${name}" skipped`, { description: msg, duration: 10_000 });
    }
  }, []);

  // SSE connection indicator
  useEffect(() => {
    const onConnect = () => {
      if (sseDownTimer.current) { clearTimeout(sseDownTimer.current); sseDownTimer.current = undefined; }
      setSseDown(false);
    };
    const onDisconnect = () => {
      if (!sseDownTimer.current) {
        sseDownTimer.current = setTimeout(() => { sseDownTimer.current = undefined; setSseDown(true); }, 2000);
      }
    };
    window.addEventListener(SSE_CONNECTED, onConnect);
    window.addEventListener(SSE_DISCONNECTED, onDisconnect);
    return () => {
      window.removeEventListener(SSE_CONNECTED, onConnect);
      window.removeEventListener(SSE_DISCONNECTED, onDisconnect);
      if (sseDownTimer.current) clearTimeout(sseDownTimer.current);
    };
  }, []);

  // Sync selected path to /t/ URL
  const navFromPopstate = useRef(false);
  useEffect(() => {
    if (navFromPopstate.current) { navFromPopstate.current = false; return; }
    const base = selected ? `/t${selected === '/' ? '' : selected}` : '/';
    const search = root !== '/' ? `?root=${encodeURIComponent(root)}` : '';
    const url = base + search;
    if (location.pathname + location.search !== url) {
      pushHistory(url);
    }
  }, [selected, root]);

  // Editor-local popstate: keep selected/root in sync when user back/forwards within /t/*
  useEffect(() => {
    const onPop = () => {
      const p = location.pathname;
      if (!p.startsWith('/t')) return; // Router will handle mode switch
      navFromPopstate.current = true;
      setSelected(p.slice(2) || '/');
      setRoot(new URLSearchParams(location.search).get('root') || '/');
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

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

  const showToast = useCallback((msg: string, type: 'success' | 'error' = 'success') => {
    setToastMsg({ text: msg, type });
    setTimeout(() => setToastMsg(null), type === 'error' ? 5000 : 2000);
  }, []);

  useEffect(() => {
    const handler = (e: PromiseRejectionEvent) => {
      const msg = e.reason?.message || String(e.reason);
      showToast(msg, 'error');
    };
    window.addEventListener('unhandledrejection', handler);
    return () => window.removeEventListener('unhandledrejection', handler);
  }, [showToast]);

  const selectPath = useCallback(
    async (path: string | null) => {
      setSelected(path);
      if (path && !cache.has(path)) {
        const node = (await trpc.get.query({ path, watch: true })) as NodeData | undefined;
        if (node) cache.put(node);
      }
    },
    [],
  );

  const handleSelect = useCallback(
    async (path: string) => {
      if (!checkBeforeNavigate()) return;
      await selectPath(path);
    },
    [selectPath],
  );

  const handleDelete = useCallback(
    async (path: string) => {
      await tree.remove(path);
      cache.remove(path);
      const parent = path === '/' ? null : path.slice(0, path.lastIndexOf('/')) || '/';
      if (parent) {
        const { items: children } = await tree.getChildren(parent, { watch: true, watchNew: true });
        cache.replaceChildren(parent, children);
      }
      await selectPath(parent);
    },
    [selectPath],
  );

  const handleAddComponent = useCallback((path: string) => {
    setAddingComponentAt(path);
  }, []);

  const handlePickComponent = useCallback(
    async (name: string, type: string) => {
      const path = addingComponentAt!;
      setAddingComponentAt(null);
      await addComponent(path, name, type);
      showToast(`Added ${name}`);
    },
    [addingComponentAt, showToast],
  );

  const [rootPromptOpen, setRootPromptOpen] = useState(false);
  const [rootPromptType, setRootPromptType] = useState('root');

  const handleCreateRoot = useCallback(async (type: string) => {
    if (!type) return;
    try {
      await tree.set({ $path: '/', $type: type } as NodeData);
      const rootNode = await tree.get('/');
      if (rootNode) cache.put(rootNode);
      setSelected('/');
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create root');
    }
  }, []);

  const handleSetRoot = (path: string) => setRoot(path);

  // Editor owns in-subtree navigation — children call navigate(path), we select it.
  const makeHref = useCallback((path: string) => `/t${path === '/' ? '' : path}`, []);

  const navigate = useCallback((path: string) => {
    if (!checkBeforeNavigate()) return;
    selectPath(path);
  }, [selectPath]);

  const navCtx = useMemo(() => makeNavigateApi(navigate, makeHref), [navigate, makeHref]);

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
    <NavigateProvider value={navCtx}>
      {sseDown && (
        <div className="fixed top-0 inset-x-0 z-50 bg-yellow-500 text-black text-center text-sm py-1">
          Reconnecting to server…
        </div>
      )}
      <div className="flex h-screen bg-background text-foreground overflow-hidden">
        <ResizablePanelGroup orientation="horizontal" className="h-full">
          <EditorSidebar
            authed={authed}
            root={root}
            selected={selected}
            onSelect={selectPath}
            onSetRoot={handleSetRoot}
            onRequestCreateRoot={() => {
              setRootPromptType('root');
              setRootPromptOpen(true);
            }}
            toast={showToast}
            onLogout={onLogout}
          />

          <ResizableHandle withHandle />

          <ResizablePanel defaultSize={72} minSize={40}>
            <Inspector
              path={selected}
              currentUserId={authed}
              onDelete={handleDelete}
              onAddComponent={handleAddComponent}
              onSelect={handleSelect}
              onSetRoot={handleSetRoot}
              toast={showToast}
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

        <AlertDialog open={rootPromptOpen} onOpenChange={setRootPromptOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Create root node</AlertDialogTitle>
            </AlertDialogHeader>
            <Input
              value={rootPromptType}
              onChange={(e) => setRootPromptType(e.target.value)}
              placeholder="$type"
              className="font-mono"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setRootPromptOpen(false);
                  handleCreateRoot(rootPromptType);
                }
              }}
            />
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => handleCreateRoot(rootPromptType)}>Create</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {toastMsg && (
          <div className={`fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg text-sm ${toastMsg.type === 'error' ? 'bg-destructive/20 text-destructive border border-destructive/30' : 'bg-primary/20 text-primary border border-primary/30'}`}>
            {toastMsg.text}
          </div>
        )}
      </div>
    </NavigateProvider>
  );
}
