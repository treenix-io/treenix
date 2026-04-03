// NodeEditor — self-contained edit panel for a node (properties, components, actions)
// Reusable: Inspector uses it as a slide-out, but can be embedded anywhere.
// State model: valtio holds only USER EDITS (deltas). Node data is always read fresh from props.

import { Button } from '#components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '#components/ui/collapsible';
import { Input } from '#components/ui/input';
import { ScrollArea } from '#components/ui/scroll-area';
import { Tabs, TabsList, TabsTrigger } from '#components/ui/tabs';
import { DraftTextarea } from '#mods/editor-ui/DraftTextarea';
import { FieldLabel, RefEditor } from '#mods/editor-ui/FieldLabel';
import { getComponents, getPlainFields, getSchema } from '#mods/editor-ui/node-utils';
import { type ComponentData, type GroupPerm, isRef, type NodeData, resolve } from '@treenity/core';
import { getDefaults } from '@treenity/core/comp';
import type { TypeSchema } from '@treenity/core/schema/types';
import { ChevronRight } from 'lucide-react';
import { useRef, useState } from 'react';
import { proxy, useSnapshot } from 'valtio';
import { AclEditor } from './AclEditor';
import * as cache from './cache';
import { ComponentSection } from './ComponentSection';
import { set } from './hooks';
import { trpc } from './trpc';

// Overlay local edits for controlled inputs — returns original ref when no edits
function withEdits(base: ComponentData, edits?: Record<string, unknown>): ComponentData {
  return edits && Object.keys(edits).length > 0 ? { ...base, ...edits } : base;
}

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
    // User edits only — empty means "use node data as-is"
    typeEdit: null as string | null,
    aclEdit: null as { owner: string; rules: GroupPerm[] } | null,
    compEdits: {} as Record<string, Record<string, unknown>>,
    plainEdits: {} as Record<string, unknown>,
    tab: 'properties' as 'properties' | 'json',
    jsonText: '',
    collapsed: { $node: true } as Record<string, boolean>,
    dirty: false,
    editRev: null as unknown,
  }));
  const snap = useSnapshot(st);

  // Reset edits on path change
  const prevPathRef = useRef<string | null>(null);
  if (node.$path !== prevPathRef.current) {
    prevPathRef.current = node.$path;
    st.typeEdit = null;
    st.aclEdit = null;
    st.compEdits = {};
    st.plainEdits = {};
    st.dirty = false;
    st.editRev = null;
    st.tab = 'properties';
    st.jsonText = '';
  }

  // Derived from node + edits
  const nodeType = snap.typeEdit ?? node.$type;
  const aclOwner = snap.aclEdit?.owner ?? (node.$owner as string) ?? '';
  const aclRules = snap.aclEdit?.rules ?? (node.$acl as GroupPerm[]) ?? [];
  const stale = snap.dirty && node.$rev !== snap.editRev;

  const nodeName = node.$path === '/' ? '/' : node.$path.slice(node.$path.lastIndexOf('/') + 1);
  const components = getComponents(node);
  const plainFields = getPlainFields(node);
  const schemaHandler = resolve(node.$type, 'schema');
  const schema = schemaHandler ? (schemaHandler() as TypeSchema) : null;
  const mainCompCls = resolve(node.$type, 'class') as (new () => Record<string, unknown>) | null;
  const mainCompDefaults = mainCompCls ? new mainCompCls() : null;

  function markDirty() {
    if (!st.dirty) {
      st.editRev = node.$rev;
      st.dirty = true;
    }
  }

  function handleReset() {
    st.typeEdit = null;
    st.aclEdit = null;
    st.compEdits = {};
    st.plainEdits = {};
    st.dirty = false;
    st.editRev = null;
  }

  async function handleSave() {
    let toSave: NodeData;
    if (st.tab === 'json') {
      try {
        toSave = JSON.parse(st.jsonText);
      } catch {
        toast('Invalid JSON');
        return;
      }
    } else {
      const mergedPlain = { ...plainFields, ...st.plainEdits };
      toSave = { ...mergedPlain, $path: node.$path, $type: nodeType, $rev: node.$rev } as NodeData;

      if (aclOwner) toSave.$owner = aclOwner;
      if (aclRules.length > 0) toSave.$acl = [...aclRules] as GroupPerm[];

      for (const [name, comp] of components) {
        const ctype = (comp as ComponentData).$type;
        const edits = st.compEdits[name];
        // Merge: node component data + user edits + defaults for missing fields
        toSave[name] = { $type: ctype, ...getDefaults(ctype), ...comp, ...edits };
      }
    }
    await set(toSave);
    handleReset();
    toast('Saved');
  }

  async function handleRemoveComponent(name: string) {
    const fresh = cache.get(node.$path) ?? node;
    const optimistic = { ...fresh };
    delete optimistic[name];
    cache.put(optimistic);
    await trpc.patch.mutate({ path: node.$path, ops: [['d', name]] });
  }

  // Build the main component value for ComponentSection: node's own fields ($type + plain data)
  // merged with any pending user edits. This is needed because the main component = node-level fields
  // (per getComponent convention), so we construct it explicitly rather than reading a named key.
  const mainValue = withEdits({ $type: node.$type, ...plainFields } as ComponentData, snap.plainEdits as Record<string, unknown>);
  const displayPlainFields = { ...plainFields, ...(snap.plainEdits as Record<string, unknown>) };
  const hasPlainFields = Object.keys(displayPlainFields).length > 0;

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
        if (v === 'json') {
          const merged = { ...node, ...st.plainEdits };
          for (const [name, comp] of components) {
            const edits = st.compEdits[name];
            if (edits && Object.keys(edits).length > 0) merged[name] = { ...comp, ...edits };
          }
          st.jsonText = JSON.stringify(merged, null, 2);
        }
      }} className="px-3 pt-2 shrink-0">
        <TabsList className="h-8 bg-secondary">
          <TabsTrigger value="properties" className="text-xs">Properties</TabsTrigger>
          <TabsTrigger value="json" className="text-xs">JSON</TabsTrigger>
        </TabsList>
      </Tabs>

      <ScrollArea className="flex-1 min-h-0">
        <div className="p-3.5">
        {snap.tab === 'properties' ? (
          <>
            <NodeCard path={node.$path} type={nodeType} onChangeType={(v) => { st.typeEdit = v; markDirty(); }} />
            <AclEditor
              path={node.$path}
              owner={aclOwner}
              rules={aclRules as GroupPerm[]}
              currentUserId={currentUserId}
              onChange={(o, r) => { st.aclEdit = { owner: o, rules: r }; markDirty(); }}
            />

            {/* Main type section */}
            <ComponentSection
              node={node}
              name=""
              value={mainValue}
              onChange={(partial) => {
                for (const [k, v] of Object.entries(partial)) if (!k.startsWith('$')) st.plainEdits[k] = v;
                markDirty();
              }}
              toast={toast}
              onActionComplete={handleReset}
            />

            {/* Named components */}
            {components.map(([name, comp]) => (
              <ComponentSection
                key={name}
                node={node}
                name={name}
                value={withEdits(comp as ComponentData, snap.compEdits[name] as Record<string, unknown>)}
                onChange={(partial) => {
                  if (!st.compEdits[name]) st.compEdits[name] = {};
                  for (const [k, v] of Object.entries(partial)) if (!k.startsWith('$')) st.compEdits[name][k] = v;
                  markDirty();
                }}
                collapsed={!!snap.collapsed[name]}
                onToggle={() => { st.collapsed[name] = !st.collapsed[name]; }}
                onRemove={() => handleRemoveComponent(name)}
                toast={toast}
                onActionComplete={handleReset}
              />
            ))}

            {/* Untyped plain data fallback */}
            {!schema && !mainCompDefaults && hasPlainFields && (
              <div className="border-t border-border mt-2 pt-0.5 first:border-t-0 first:mt-0 first:pt-0">
                <div className="flex items-center justify-between py-2 pb-1.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Data</div>
                <div className="py-0.5 pb-2.5">
                  {Object.entries(displayPlainFields).map(([k, v]) => {
                    const onCh = (next: unknown) => { st.plainEdits[k] = next; markDirty(); };
                    return (
                      <div key={k} className={`field${typeof v === 'object' && v !== null ? ' stack' : ''}`}>
                        <FieldLabel label={k} value={v} onChange={onCh} />
                        {typeof v === 'object' && isRef(v) ? (
                          <RefEditor value={v as { $ref: string; $map?: string }} onChange={onCh} />
                        ) : (
                          <Input
                            className="h-7 text-xs"
                            value={typeof v === 'string' ? v : JSON.stringify(v)}
                            onChange={(e) => { st.plainEdits[k] = e.target.value; markDirty(); }}
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
            onChange={(text) => { st.jsonText = text; markDirty(); }}
            spellCheck={false}
          />
        )}
        </div>
      </ScrollArea>

      <div className="edit-panel-actions">
        {stale && (
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
