import { useEffect, useRef, useState } from 'react';
import {
  W,
  type AclEntry,
  type Node,
  type Principal,
  type ErrorCode,
  type Rev,
} from '@treenx/core/kernel/types';
import { componentEntries } from '@treenx/core/kernel/migrate';
import { KernelError } from '@treenx/core/errors';
import { isNode, isNodeInput } from '@treenx/core/kernel/input-boundary';
import { useTreeEffects } from '#hooks';
import type { TreeEffects } from '#tree/effects';
import type { SaveHandle } from '#tree/auto-save';
import type { PresentationNode } from '#tree/presentation';
import { Button } from '#components/ui/button';
import { JsonEditor } from '#mods/editor-ui/JsonEditor';
import { ComponentSection } from './ComponentSection';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '#components/ui/collapsible';
import { ScrollArea } from '#components/ui/scroll-area';
import { Tabs, TabsList, TabsTrigger } from '#components/ui/tabs';
import { ConfirmPopover } from '#components/ConfirmPopover';
import { mergeIntoNode, type OnChange } from '#tree/on-change';
import { ChevronRight, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { AclEditor } from './AclEditor';

export interface NodeEditorProps {
  readonly node: Node;
  readonly save?: SaveHandle<PresentationNode>;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onDelete?: () => void;
  readonly onAddComponent?: (path: string) => void;
}
interface Draft {
  readonly effects: TreeEffects;
  readonly path: string;
  readonly generation: number;
  readonly node: Node;
  readonly baseRev: Rev;
  readonly baseline: string;
  readonly text: string;
  readonly mode: 'properties' | 'json';
  readonly error?: string;
  readonly errorCode?: ErrorCode;
  readonly busy: boolean;
}

/** Bind a loaded full-node revision to exactly one selected-source editor lifetime. */
function load(node: Node, effects: TreeEffects, generation: number): Draft {
  const text = JSON.stringify(node, null, 2);
  return {
    effects,
    path: node.$path,
    generation,
    node,
    baseRev: node.$rev,
    baseline: text,
    text,
    mode: 'properties',
    busy: false,
  };
}

// Skip $acl/$owner — AclEditor renders them.
const NODE_CARD_SKIP = new Set(['$acl', '$owner']);

function formatSystemValue(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

function NodeCard({ node }: { node: PresentationNode }) {
  const entries = Object.entries(node).filter(([k]) => k.startsWith('$') && !NODE_CARD_SKIP.has(k));
  return (
    <Collapsible className="border-t border-border mt-2 pt-0.5 first:border-t-0 first:mt-0 first:pt-0">
      <CollapsibleTrigger className="group flex w-full items-center justify-between py-2 pb-1.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider cursor-pointer select-none">
        <span>Node</span>
        <span className="flex items-center gap-2 normal-case tracking-normal font-normal text-[11px] font-mono text-foreground/50">
          <span className="group-data-[state=open]:hidden truncate">{node.$path}</span>
          <span className="text-primary group-data-[state=open]:hidden">{node.$type}</span>
          <ChevronRight className="h-3 w-3 transition-transform duration-200 group-data-[state=open]:rotate-90" />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="py-0.5 pb-2.5">
          {entries.map(([k, v]) => {
            const text = formatSystemValue(v);
            return (
              <div key={k} className="field">
                <label>{k}</label>
                <span className="text-xs font-mono text-muted-foreground truncate" title={text}>
                  {text}
                </span>
              </div>
            );
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Keep form and JSON edits under one expected native revision until the canonical put settles. */
export function NodeEditor({
  node,
  save: pendingSave,
  open,
  onClose,
  onDelete,
  onAddComponent,
}: NodeEditorProps) {
  const effects = useTreeEffects();
  const nextGeneration = useRef(0);
  const current = useRef<{ generation: number; mounted: boolean }>({
    generation: 0,
    mounted: true,
  });
  const pending = useRef<{ generation: number; token: symbol } | undefined>(undefined);
  const [draft, setDraft] = useState(() => load(node, effects, 0));
  const fresh = JSON.stringify(node, null, 2);
  let owned = draft;

  if (draft.effects !== effects || draft.path !== node.$path) {
    nextGeneration.current += 1;
    owned = load(node, effects, nextGeneration.current);
    setDraft(owned);
  } else if (!draft.busy && draft.text === draft.baseline && draft.baseline !== fresh) {
    owned = { ...load(node, effects, draft.generation), mode: draft.mode };
    setDraft(owned);
  }
  current.current.generation = owned.generation;
  const generation = owned.generation;
  useEffect(() => {
    current.current.mounted = true;
    return () => {
      current.current.mounted = false;
    };
  }, [generation]);
  const bits = effects.bits(node.$path) ?? 0;
  const dirty = owned.text !== owned.baseline;
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const propertyNode = dirty ? owned.node : (pendingSave?.value ?? owned.node);

  /** Retained callbacks never become valid again after a source or path round trip. */
  function assertOwner(): void {
    if (!current.current.mounted || current.current.generation !== generation)
      throw new KernelError('CANCELLED', 'The editor owner changed');
  }

  /** Form fields retain the complete node, including every untouched component and loaded revision. */
  function edit(value: Node): void {
    assertOwner();
    if (pending.current?.generation === generation)
      throw new KernelError('UNAVAILABLE', 'The editor save is pending');
    setDraft((previous) => ({
      ...previous,
      node: value,
      text: JSON.stringify(value, null, 2),
      error: undefined,
    }));
  }

  /** Decode user JSON before replacing the form draft. */
  function editJson(text: string): void {
    assertOwner();
    if (pending.current?.generation === generation)
      throw new KernelError('UNAVAILABLE', 'The editor save is pending');
    try {
      const value: unknown = JSON.parse(text);
      if (!isNode(value) || value.$path !== owned.path)
        throw new KernelError('INVALID', 'A node at the loaded path is required');
      setDraft((previous) => ({ ...previous, text, node: value, error: undefined }));
    } catch (reason) {
      setDraft((previous) => ({
        ...previous,
        text,
        error: reason instanceof Error ? reason.message : String(reason),
      }));
    }
  }

  /** Put the visible full node under its loaded revision; the server preserves hidden administration metadata. */
  async function save(): Promise<void> {
    assertOwner();
    if (pending.current?.generation === generation) return;
    const token = Symbol('editor-save');
    pending.current = { generation, token };
    setDraft((previous) => ({ ...previous, busy: true, error: undefined }));
    try {
      const value: unknown = JSON.parse(owned.text);
      if (!isNode(value) || value.$path !== owned.path)
        throw new KernelError('INVALID', 'A loaded node revision is required');
      const { $id, $rev, $pos, ...input } = value;
      if (!isNodeInput(input)) throw new KernelError('INVALID', 'Invalid full node input');
      const kernel = effects.kernel;
      if (kernel === undefined)
        throw new KernelError('UNAVAILABLE', 'Canonical editing requires a native source');
      await pendingSave?.settle();
      assertOwner();
      pendingSave?.discard();
      await kernel.commit({
        changes: [{ op: 'put', node: input }],
        expect: { nodes: [{ path: input.$path, rev: owned.baseRev }] },
      });
      assertOwner();
      setDraft((previous) => ({ ...previous, baseline: owned.text, busy: false }));
    } catch (reason) {
      if (!current.current.mounted || current.current.generation !== generation) return;
      setDraft((previous) => ({
        ...previous,
        busy: false,
        error: reason instanceof Error ? reason.message : String(reason),
        errorCode: reason instanceof KernelError ? reason.code : undefined,
      }));
    } finally {
      if (pending.current?.token === token) pending.current = undefined;
    }
  }

  /** ACL edits share the full-node buffer and its original OCC revision. */
  function editAcl(owner: Principal | undefined, rules: readonly AclEntry[]): void {
    const { $owner, ...withoutOwner } = propertyNode;
    edit({
      ...withoutOwner,
      $id: owned.node.$id,
      $rev: owned.baseRev,
      $path: owned.path,
      $type: owned.node.$type,
      ...(owner === undefined ? {} : { $owner: owner }),
      $acl: rules,
    });
  }

  /** Preserve normal field autosave through the Inspector's native draft owner. */
  function changeProperties(partial: OnChange, component = ''): void {
    assertOwner();
    if (pendingSave !== undefined && !dirty) {
      const change = component === '' ? pendingSave.onChange : pendingSave.scope(component);
      change(partial);
      return;
    }

    const scoped = Object.fromEntries(
      Object.entries(partial).map(([field, value]) => [
        component === '' ? field : `${component}.${field}`,
        value,
      ]),
    );
    edit(mergeIntoNode(owned.node, scoped));
  }

  /** A properties save either flushes field edits or publishes the complete system-field draft. */
  async function saveProperties(): Promise<void> {
    if (dirty) await save();
    else await pendingSave?.flush();
  }

  /** Seed JSON from the visible field draft before releasing its pending autosave timer. */
  function selectTab(mode: string): void {
    if (mode !== 'properties' && mode !== 'json')
      throw new KernelError('INVALID', 'Unknown editor tab');
    if (mode === 'json') {
      const value = dirty ? owned.node : (pendingSave?.value ?? owned.node);
      const text = JSON.stringify(value, null, 2);
      setDraft((previous) => ({ ...previous, mode, ...(dirty ? {} : { text, baseline: fresh }) }));
      pendingSave?.discard();
    } else setDraft((previous) => ({ ...previous, mode }));
  }

  const nodeName = node.$path === '/' ? '/' : node.$path.slice(node.$path.lastIndexOf('/') + 1);
  const propertyDirty = dirty || pendingSave?.dirty;
  const stale = (dirty && owned.baseline !== fresh) || pendingSave?.stale;

  return (
    <div className={`edit-panel${open ? ' open' : ''}`} aria-label="Node editor">
      <div className="edit-panel-header">
        <span>Edit {nodeName}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0"
          onClick={onClose}
          aria-label="Close editor"
        >
          &#10005;
        </Button>
      </div>

      <Tabs value={owned.mode} onValueChange={selectTab} className="shrink-0">
        <TabsList variant="line" className="h-8">
          <TabsTrigger value="properties" className="text-xs">
            Properties
          </TabsTrigger>
          <TabsTrigger value="json" className="text-xs">
            JSON
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <ScrollArea className="flex-1 min-h-0">
        <fieldset disabled={owned.busy} className="p-3.5 min-w-0">
          {owned.error !== undefined && (
            <p role="alert" data-error-code={owned.errorCode} className="text-destructive text-xs">
              {owned.error}
            </p>
          )}
          {open &&
            (owned.mode === 'properties' ? (
              <>
                <NodeCard node={propertyNode} />
                <AclEditor
                  path={owned.path}
                  bits={bits}
                  owner={owned.node.$owner}
                  rules={owned.node.$acl ?? []}
                  onChange={editAcl}
                />
                {componentEntries(propertyNode).map(([name, value]) => {
                  return (
                    <ComponentSection
                      key={`${generation}:${name}`}
                      node={propertyNode}
                      name={name}
                      value={name === '' ? propertyNode : value}
                      collapsed={collapsed[name]}
                      onToggle={
                        name === ''
                          ? undefined
                          : () =>
                              setCollapsed((previous) => ({ ...previous, [name]: !previous[name] }))
                      }
                      onChange={
                        (bits & W) === 0 ? undefined : (partial) => changeProperties(partial, name)
                      }
                      onRemove={
                        name === '' || (bits & W) === 0
                          ? undefined
                          : () => {
                              void effects
                                .patchNode(node.$path, { [name]: undefined })
                                .catch((error) => {
                                  toast.error(
                                    error instanceof Error
                                      ? error.message
                                      : `Failed to remove ${name}`,
                                  );
                                });
                            }
                      }
                    />
                  );
                })}
              </>
            ) : (
              <JsonEditor value={owned.text} onChange={editJson} />
            ))}
        </fieldset>
      </ScrollArea>

      <div className="edit-panel-actions">
        {(owned.mode === 'json' ? dirty : propertyDirty) && (
          <>
            <Button
              size="sm"
              disabled={owned.busy || (bits & W) === 0}
              onClick={() => {
                void (owned.mode === 'json' ? save() : saveProperties());
              }}
            >
              {owned.mode === 'json' ? 'Save JSON' : 'Save'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={owned.busy}
              onClick={() => {
                assertOwner();
                if (pending.current?.generation === generation) return;
                pendingSave?.reset();
                setDraft({ ...load(node, effects, generation), mode: owned.mode });
              }}
            >
              Reset
            </Button>
          </>
        )}
        {stale && (
          <span className="text-[10px] text-orange-500" title="Node changed externally">
            stale
          </span>
        )}
        {owned.mode === 'properties' && (bits & W) !== 0 && onAddComponent !== undefined && (
          <Button
            variant="outline"
            size="sm"
            disabled={owned.busy}
            onClick={() => onAddComponent(node.$path)}
          >
            + Component
          </Button>
        )}
        <span className="flex-1" />
        {(bits & W) !== 0 && onDelete !== undefined && (
          <ConfirmPopover
            title={`Delete "${nodeName}"?`}
            variant="destructive"
            onConfirm={onDelete}
          >
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground/50 hover:text-destructive"
              disabled={owned.busy}
              aria-label="Delete node"
            >
              <Trash2 className="size-3.5" />
            </Button>
          </ConfirmPopover>
        )}
      </div>
    </div>
  );
}
