// NodeEditor — self-contained edit panel for a node (properties, components, actions)
// Reusable: Inspector uses it as a slide-out, but can be embedded anywhere.
// Data fields auto-save via patch (no $rev). System fields ($type, $acl) use Save button.

import { Button } from '#components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '#components/ui/collapsible';
import { Input } from '#components/ui/input';
import { ScrollArea } from '#components/ui/scroll-area';
import { Tabs, TabsList, TabsTrigger } from '#components/ui/tabs';
import { ConfirmPopover } from '#components/ConfirmPopover';
import { JsonEditor } from '#mods/editor-ui/JsonEditor';
import { removeComponent, set } from '#hooks';
import { getComponents } from '#mods/editor-ui/node-utils';
import type { SaveHandle } from '#tree/auto-save';
import { type ComponentData, type GroupPerm, type NodeData } from '@treenx/core';
import { ChevronRight, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { proxy, useSnapshot } from 'valtio';
import { AclEditor } from './AclEditor';
import { ComponentSection } from './ComponentSection';
import { getNodeEditorJsonText, saveNodeEditorJson } from './node-editor-state';

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
  save: SaveHandle;
  open: boolean;
  onClose: () => void;
  onDelete?: () => void;
  currentUserId?: string;
  onAddComponent: (path: string) => void;
};

export function NodeEditor({ node, save, open, onClose, onDelete, currentUserId, onAddComponent }: NodeEditorProps) {
  const { onChange, scope, flush, reset: resetSave, dirty, stale } = save;

  // Valtio only for system fields ($type, $acl) and UI state
  const [st] = useState(() => proxy({
    typeEdit: null as string | null,
    aclEdit: null as { owner: string; rules: GroupPerm[] } | null,
    tab: 'properties' as 'properties' | 'json',
    jsonText: '',
    collapsed: { $node: true } as Record<string, boolean>,
  }));
  const snap = useSnapshot(st);

  // Reset on path change
  const prevPathRef = useRef<string | null>(null);
  if (node.$path !== prevPathRef.current) {
    prevPathRef.current = node.$path;
    st.typeEdit = null;
    st.aclEdit = null;
    st.tab = 'properties';
    st.jsonText = '';
  }

  // Derived from node + system edits
  const formattedNodeJson = getNodeEditorJsonText(node);
  const nodeType = snap.typeEdit ?? node.$type;
  const aclOwner = snap.aclEdit?.owner ?? (node.$owner as string) ?? '';
  const aclRules = snap.aclEdit?.rules ?? (node.$acl as GroupPerm[]) ?? [];
  const jsonDirty = snap.jsonText !== '' && snap.jsonText !== formattedNodeJson;
  const hasPendingSystemEdits = snap.typeEdit != null || snap.aclEdit != null;

  const nodeName = node.$path === '/' ? '/' : node.$path.slice(node.$path.lastIndexOf('/') + 1);
  const components = getComponents(node);

  // Reset only the properties tab state (system field edits + auto-save buffer)
  function resetProperties() {
    st.typeEdit = null;
    st.aclEdit = null;
    resetSave();
  }

  // Reset only the JSON tab buffer back to current node
  function resetJson() {
    st.jsonText = formattedNodeJson;
  }

  // Save properties tab: $type/$acl via set(), then flush auto-save buffer
  async function handleSaveProperties() {
    try {
      if (hasPendingSystemEdits) {
        const toSave = { ...node };
        if (snap.typeEdit) toSave.$type = snap.typeEdit;
        if (snap.aclEdit) {
          toSave.$owner = aclOwner;
          toSave.$acl = [...aclRules] as GroupPerm[];
        }
        await set(toSave);
      }
      await flush();
      resetProperties();
      toast.success('Saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Save failed');
    }
  }

  // Save JSON tab: full-node replacement via set()
  async function handleSaveJson() {
    try {
      st.jsonText = await saveNodeEditorJson(snap.jsonText, set);
      toast.success('Saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Save failed');
    }
  }

  async function handleRemoveComponent(name: string) {
    await removeComponent(node.$path, name);
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
        if (v === 'json' && !st.jsonText) {
          st.jsonText = formattedNodeJson;
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
            <NodeCard path={node.$path} type={nodeType} onChangeType={(v) => { st.typeEdit = v; }} />
            <AclEditor
              path={node.$path}
              owner={aclOwner}
              rules={aclRules as GroupPerm[]}
              currentUserId={currentUserId}
              onChange={(o, r) => { st.aclEdit = { owner: o, rules: r }; }}
            />

            {/* Main type section — node IS the main component (getComponent returns
                node when types match). Cache stamps $node on the node itself, so
                useActions / viewCtx work without synthesis. */}
            <ComponentSection
              node={node}
              name=""
              value={node}
              onChange={onChange}
              onActionComplete={resetProperties}
            />

            {/* Named components — scoped auto-save onChange */}
            {components.map(([name, comp]) => (
              <ComponentSection
                key={name}
                node={node}
                name={name}
                value={comp as ComponentData}
                onChange={scope(name)}
                collapsed={!!snap.collapsed[name]}
                onToggle={() => { st.collapsed[name] = !st.collapsed[name]; }}
                onRemove={() => handleRemoveComponent(name)}
                onActionComplete={resetProperties}
              />
            ))}
          </>
        ) : (
          <JsonEditor
            value={snap.jsonText}
            onChange={(text) => { st.jsonText = text; }}
          />
        )}
        </div>
      </ScrollArea>

      <div className="edit-panel-actions">
        {snap.tab === 'properties' ? (
          <>
            {(dirty || hasPendingSystemEdits) && (
              <Button size="sm" onClick={handleSaveProperties}>Save</Button>
            )}
            {(dirty || hasPendingSystemEdits) && (
              <Button variant="ghost" size="sm" onClick={resetProperties} title="Discard property changes">
                Reset
              </Button>
            )}
            {stale && (
              <span className="text-[10px] text-orange-500" title="Node changed externally">stale</span>
            )}
            <Button variant="outline" size="sm" onClick={() => onAddComponent(node.$path)}>+ Component</Button>
          </>
        ) : (
          <>
            {jsonDirty && (
              <Button size="sm" onClick={handleSaveJson}>Save JSON</Button>
            )}
            {jsonDirty && (
              <Button variant="ghost" size="sm" onClick={resetJson} title="Discard JSON edits">
                Reset
              </Button>
            )}
          </>
        )}
        <span className="flex-1" />
        {onDelete && (
          <ConfirmPopover title={`Delete "${nodeName}"?`} variant="destructive" onConfirm={onDelete}>
            <Button variant="ghost" size="sm" className="text-muted-foreground/50 hover:text-destructive">
              <Trash2 className="size-3.5" />
            </Button>
          </ConfirmPopover>
        )}
      </div>

    </div>
  );
}
