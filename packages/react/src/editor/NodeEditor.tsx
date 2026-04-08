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
import { FieldLabel, RefEditor } from '#mods/editor-ui/FieldLabel';
import { getComponents, getPlainFields } from '#mods/editor-ui/node-utils';
import type { SaveHandle } from '#tree/auto-save';
import { type ComponentData, type GroupPerm, isRef, type NodeData, resolve } from '@treenity/core';
import type { TypeSchema } from '@treenity/core/schema/types';
import { ChevronRight, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { proxy, useSnapshot } from 'valtio';
import { AclEditor } from './AclEditor';
import { ComponentSection } from './ComponentSection';

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
  toast: (msg: string) => void;
  onAddComponent: (path: string) => void;
};

export function NodeEditor({ node, save, open, onClose, onDelete, currentUserId, toast, onAddComponent }: NodeEditorProps) {
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
  const nodeType = snap.typeEdit ?? node.$type;
  const aclOwner = snap.aclEdit?.owner ?? (node.$owner as string) ?? '';
  const aclRules = snap.aclEdit?.rules ?? (node.$acl as GroupPerm[]) ?? [];
  const jsonDirty = snap.jsonText !== '' && snap.jsonText !== JSON.stringify(node, null, 2);
  const hasPendingSystemEdits = snap.typeEdit != null || snap.aclEdit != null;

  const nodeName = node.$path === '/' ? '/' : node.$path.slice(node.$path.lastIndexOf('/') + 1);
  const components = getComponents(node);
  const plainFields = getPlainFields(node);
  const schemaHandler = resolve(node.$type, 'schema');
  const schema = schemaHandler ? (schemaHandler() as TypeSchema) : null;
  const mainCompCls = resolve(node.$type, 'class') as (new () => Record<string, unknown>) | null;
  const mainCompDefaults = mainCompCls ? new mainCompCls() : null;

  function handleReset() {
    st.typeEdit = null;
    st.aclEdit = null;
    st.jsonText = '';
    resetSave();
  }

  async function handleSave() {
    if (snap.tab === 'json') {
      // JSON tab — full node replacement via set()
      try {
        const toSave = JSON.parse(snap.jsonText);
        await set(toSave);
      } catch {
        toast('Invalid JSON');
        return;
      }
    } else if (hasPendingSystemEdits) {
      // System field changes ($type, $acl) — need set()
      const toSave = { ...node };
      if (snap.typeEdit) toSave.$type = snap.typeEdit;
      if (snap.aclEdit) {
        toSave.$owner = aclOwner;
        toSave.$acl = [...aclRules] as GroupPerm[];
      }
      await set(toSave);
    }

    // Flush any pending auto-save data
    await flush();
    handleReset();
    toast('Saved');
  }

  async function handleRemoveComponent(name: string) {
    await removeComponent(node.$path, name);
  }

  // Main component value: node's own fields (cache has optimistic updates from auto-save)
  const mainValue = { $type: node.$type, ...plainFields } as ComponentData;
  const hasPlainFields = Object.keys(plainFields).length > 0;

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
          st.jsonText = JSON.stringify(node, null, 2);
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

            {/* Main type section — auto-save onChange */}
            <ComponentSection
              node={node}
              name=""
              value={mainValue}
              onChange={onChange}
              toast={toast}
              onActionComplete={handleReset}
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
                toast={toast}
                onActionComplete={handleReset}
              />
            ))}

            {/* Untyped plain data fallback */}
            {!schema && !mainCompDefaults && hasPlainFields && (
              <div className="border-t border-border mt-2 pt-0.5 first:border-t-0 first:mt-0 first:pt-0">
                <div className="flex items-center justify-between py-2 pb-1.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Data</div>
                <div className="py-0.5 pb-2.5">
                  {Object.entries(plainFields).map(([k, v]) => {
                    const onCh = (next: unknown) => onChange({ [k]: next });
                    return (
                      <div key={k} className={`field${typeof v === 'object' && v !== null ? ' stack' : ''}`}>
                        <FieldLabel label={k} value={v} onChange={onCh} />
                        {typeof v === 'object' && isRef(v) ? (
                          <RefEditor value={v as { $ref: string; $map?: string }} onChange={onCh} />
                        ) : (
                          <Input
                            className="h-7 text-xs"
                            value={typeof v === 'string' ? v : JSON.stringify(v)}
                            onChange={(e) => onChange({ [k]: e.target.value })}
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
          <JsonEditor
            value={snap.jsonText}
            onChange={(text) => { st.jsonText = text; }}
          />
        )}
        </div>
      </ScrollArea>

      <div className="edit-panel-actions">
        {(dirty || hasPendingSystemEdits || jsonDirty) && (
          <Button size="sm" onClick={handleSave}>Save</Button>
        )}
        {(dirty || hasPendingSystemEdits || jsonDirty) && (
          <Button variant="ghost" size="sm" onClick={handleReset} title="Discard all changes">
            Reset
          </Button>
        )}
        {stale && (
          <span className="text-[10px] text-orange-500" title="Node changed externally">stale</span>
        )}
        {snap.tab === 'properties' && (
          <Button variant="outline" size="sm" onClick={() => onAddComponent(node.$path)}>+ Component</Button>
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
