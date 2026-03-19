// NodeEditor — self-contained edit panel for a node (properties, components, actions)
// Reusable: Inspector uses it as a slide-out, but can be embedded anywhere.

import { Button } from '#components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '#components/ui/collapsible';
import { Input } from '#components/ui/input';
import { ScrollArea } from '#components/ui/scroll-area';
import { Tabs, TabsList, TabsTrigger } from '#components/ui/tabs';
import { toPlain } from '#lib/to-plain';
import { DraftTextarea } from '#mods/editor-ui/DraftTextarea';
import { FieldLabel, RefEditor } from '#mods/editor-ui/FieldLabel';
import { getComponents, getPlainFields, getSchema } from '#mods/editor-ui/node-utils';
import { type ComponentData, type GroupPerm, isRef, type NodeData, resolve } from '@treenity/core';
import type { TypeSchema } from '@treenity/core/schema/types';
import { ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { proxy, snapshot, useSnapshot } from 'valtio';
import { AclEditor } from './AclEditor';
import * as cache from './cache';
import { ComponentSection } from './ComponentSection';
import { set } from './hooks';

type AnyClass = { new(): Record<string, unknown> };

function NodeCard({ path, type, onChangeType }: {
  path: string;
  type: string;
  onChangeType: (t: string) => void;
}) {
  return (
    <Collapsible className="border-t border-border mt-2 pt-0.5 first:border-t-0 first:mt-0 first:pt-0">
      <CollapsibleTrigger className="flex w-full items-center justify-between py-2 pb-1.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider cursor-pointer select-none">
        <span>Node</span>
        <span className="flex items-center gap-2 normal-case tracking-normal font-normal text-[11px] font-mono text-foreground/50">
          {path}
          <span className="text-primary">{type}</span>
          <ChevronRight className="h-3 w-3 transition-transform duration-200 group-data-[state=open]:rotate-90" />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="py-0.5 pb-2.5">
          <div className="field">
            <label>$path</label>
            <Input className="h-7 text-xs" value={path} readOnly />
          </div>
          <div className="field">
            <label>$type</label>
            <Input className="h-7 text-xs" value={type} onChange={(e) => onChangeType(e.target.value)} />
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export type NodeEditorProps = {
  node: NodeData;
  open: boolean;
  onClose: () => void;
  currentUserId?: string;
  toast: (msg: string) => void;
  onAddComponent: (path: string) => void;
};

export function NodeEditor({ node, open, onClose, currentUserId, toast, onAddComponent }: NodeEditorProps) {
  const [st] = useState(() => proxy({
    nodeType: '',
    compTexts: {} as Record<string, string>,
    compData: {} as Record<string, Record<string, unknown>>,
    plainData: {} as Record<string, unknown>,
    tab: 'properties' as 'properties' | 'json',
    jsonText: '',
    collapsed: { $node: true } as Record<string, boolean>,
    aclOwner: '',
    aclRules: [] as GroupPerm[],
    dirty: false,
    stale: false,
    syncedPath: null as string | null,
    syncedRev: null as unknown,
  }));
  const snap = useSnapshot(st);

  function syncFromNode(n: NodeData) {
    st.nodeType = n.$type;
    st.aclOwner = (n.$owner as string) ?? '';
    st.aclRules = n.$acl ? [...(n.$acl as GroupPerm[])] : [];
    const texts: Record<string, string> = {};
    const cdata: Record<string, Record<string, unknown>> = {};
    for (const [name, comp] of getComponents(n)) {
      texts[name] = JSON.stringify(comp, null, 2);
      const d: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(comp)) {
        if (!k.startsWith('$')) d[k] = v;
      }
      cdata[name] = d;
    }
    st.compTexts = texts;
    st.compData = cdata;
    st.plainData = getPlainFields(n);
    st.jsonText = JSON.stringify(n, null, 2);
    st.tab = 'properties';
  }

  useEffect(() => {
    const pathChanged = node.$path !== st.syncedPath;
    if (pathChanged) {
      syncFromNode(node);
      st.syncedPath = node.$path;
      st.syncedRev = node.$rev;
      st.dirty = false;
      st.stale = false;
      return;
    }

    if (node.$rev !== st.syncedRev) {
      if (st.dirty) {
        st.stale = true;
      } else {
        syncFromNode(node);
        st.syncedRev = node.$rev;
      }
    }
  }, [node.$path, node.$rev]);

  function handleReset() {
    const current = cache.get(node.$path) ?? node;
    syncFromNode(current);
    st.syncedRev = current.$rev;
    st.dirty = false;
    st.stale = false;
  }

  const nodeName = node.$path === '/' ? '/' : node.$path.slice(node.$path.lastIndexOf('/') + 1);
  const components = getComponents(node);
  const schemaHandler = resolve(node.$type, 'schema');
  const schema = schemaHandler ? (schemaHandler() as TypeSchema) : null;
  const mainCompCls = resolve(node.$type, 'class') as AnyClass | null;
  const mainCompDefaults = mainCompCls ? new mainCompCls() : null;

  async function handleSave() {
    const s = toPlain(snapshot(st));
    let toSave: NodeData;
    if (s.tab === 'json') {
      try {
        toSave = JSON.parse(s.jsonText);
      } catch {
        toast('Invalid JSON');
        return;
      }
    } else {
      toSave = { $path: node.$path, $type: s.nodeType, ...s.plainData } as NodeData;
      if (s.aclOwner) toSave.$owner = s.aclOwner;
      if (s.aclRules.length > 0) toSave.$acl = [...s.aclRules] as GroupPerm[];
      for (const [name, comp] of components) {
        const ctype = (comp as ComponentData).$type;
        const cschema = getSchema(ctype);
        const cd = s.compData[name];
        if ((cschema || (cd && Object.keys(cd).length > 0)) && cd) {
          toSave[name] = { $type: ctype, ...cd };
        } else {
          const text = s.compTexts[name];
          if (text === undefined) continue;
          try {
            toSave[name] = JSON.parse(text);
          } catch {
            toast(`Invalid JSON in component: ${name}`);
            return;
          }
        }
      }
    }
    await set(toSave);
    const fresh = cache.get(node.$path);
    if (fresh) {
      syncFromNode(fresh);
      st.syncedRev = fresh.$rev;
    }
    st.dirty = false;
    st.stale = false;
    toast('Saved');
  }

  function handleRemoveComponent(name: string) {
    const next = { ...node };
    delete next[name];
    set(next);
  }

  return (
    <div className={`edit-panel${open ? ' open' : ''}`}>
      <div className="edit-panel-header">
        <span>Edit {nodeName}</span>
        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={onClose}>
          &#10005;
        </Button>
      </div>

      <Tabs value={snap.tab} onValueChange={(v) => {
        st.tab = v as 'properties' | 'json';
        if (v === 'json') st.jsonText = JSON.stringify({ ...node, ...st.plainData }, null, 2);
      }} className="px-3 pt-2">
        <TabsList className="h-8 bg-secondary">
          <TabsTrigger value="properties" className="text-xs">Properties</TabsTrigger>
          <TabsTrigger value="json" className="text-xs">JSON</TabsTrigger>
        </TabsList>
      </Tabs>

      <ScrollArea className="flex-1">
        <div className="p-3.5">
        {snap.tab === 'properties' ? (
          <>
            <NodeCard path={node.$path} type={snap.nodeType} onChangeType={(v) => { st.nodeType = v; st.dirty = true; }} />
            <AclEditor
              path={node.$path}
              owner={snap.aclOwner}
              rules={snap.aclRules as GroupPerm[]}
              currentUserId={currentUserId}
              onChange={(o, r) => { st.aclOwner = o; st.aclRules = r; st.dirty = true; }}
            />

            {/* Main type section */}
            <ComponentSection
              node={node}
              name=""
              compType={node.$type}
              data={snap.plainData as Record<string, unknown>}
              onData={(d) => { st.plainData = d; st.dirty = true; }}
              toast={toast}
              onActionComplete={handleReset}
            />

            {/* Named components */}
            {components.map(([name, comp]) => (
              <ComponentSection
                key={name}
                node={node}
                name={name}
                compType={(comp as ComponentData).$type}
                data={(snap.compData[name] ?? {}) as Record<string, unknown>}
                onData={(d) => { st.compData[name] = d; st.dirty = true; }}
                collapsed={!!snap.collapsed[name]}
                onToggle={() => { st.collapsed[name] = !st.collapsed[name]; }}
                onRemove={() => handleRemoveComponent(name)}
                toast={toast}
                onActionComplete={handleReset}
              />
            ))}

            {/* Untyped plain data fallback */}
            {!schema && !mainCompDefaults && Object.keys(snap.plainData).length > 0 && (
              <div className="border-t border-border mt-2 pt-0.5 first:border-t-0 first:mt-0 first:pt-0">
                <div className="flex items-center justify-between py-2 pb-1.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Data</div>
                <div className="py-0.5 pb-2.5">
                  {Object.entries(snap.plainData).map(([k, v]) => {
                    const onCh = (next: unknown) => { st.plainData[k] = next; st.dirty = true; };
                    return (
                      <div key={k} className={`field${typeof v === 'object' && v !== null ? ' stack' : ''}`}>
                        <FieldLabel label={k} value={v} onChange={onCh} />
                        {typeof v === 'object' && isRef(v) ? (
                          <RefEditor value={v as { $ref: string; $map?: string }} onChange={onCh} />
                        ) : (
                          <Input
                            className="h-7 text-xs"
                            value={typeof v === 'string' ? v : JSON.stringify(v)}
                            onChange={(e) => { st.plainData[k] = e.target.value; st.dirty = true; }}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        ) : (
          <DraftTextarea
            value={snap.jsonText}
            onChange={(text) => { st.jsonText = text; st.dirty = true; }}
            spellCheck={false}
          />
        )}
        </div>
      </ScrollArea>

      <div className="edit-panel-actions">
        {snap.stale && (
          <Button variant="ghost" size="sm" onClick={handleReset} title="Node updated externally">
            Reset
          </Button>
        )}
        <Button size="sm" onClick={handleSave}>
          Save
        </Button>
        {snap.tab === 'properties' && (
          <Button variant="outline" size="sm" onClick={() => onAddComponent(node.$path)}>+ Component</Button>
        )}
      </div>

    </div>
  );
}
