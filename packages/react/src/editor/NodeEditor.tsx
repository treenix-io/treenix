import { useEffect, useRef, useState } from 'react';
import { A, W, type AclEntry, type Node, type Principal, type ErrorCode, type Component, type Rev } from '@treenx/core/kernel/types';
import { componentEntries } from '@treenx/core/kernel/migrate';
import { KernelError } from '@treenx/core/errors';
import { isNode, isNodeInput } from '@treenx/core/kernel/input-boundary';
import { useTreeEffects } from '#hooks';
import type { TreeEffects } from '#tree/effects';
import type { SaveHandle } from '#tree/auto-save';
import type { PresentationNode } from '#tree/presentation';
import { Button } from '#components/ui/button';
import { JsonEditor } from '#mods/editor-ui/JsonEditor';
import { NativeActionCards } from './NativeActionCards';
import { useNativeTypeDescription } from '#schema-loader';
import { NativeSchemaForm } from './NativeSchemaFields';
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
  return { effects, path: node.$path, generation, node, baseRev: node.$rev, baseline: text, text, mode: 'properties', busy: false };
}

/** Own one description for a component's existing field widgets and actual action controls. */
function ComponentPanel({ path, name, value, onChange }: {
  path: string; name: string; value: Component; onChange: (field: string, value: unknown) => void;
}) {
  const description = useNativeTypeDescription(value.$type);
  if (description === undefined) return <p>Loading schema…</p>;

  return <><NativeSchemaForm schema={description.schema} value={value} onChange={onChange} />
    <NativeActionCards path={path} type={value.$type} component={name === '' ? undefined : name} description={description} /></>;
}

/** Keep form and JSON edits under one expected native revision until the canonical put settles. */
export function NodeEditor({ node, save: pendingSave, open, onClose, onDelete, onAddComponent }: NodeEditorProps) {
  const effects = useTreeEffects();
  const nextGeneration = useRef(0);
  const current = useRef<{ generation: number; mounted: boolean }>({ generation: 0, mounted: true });
  const pending = useRef<{ generation: number; token: symbol } | undefined>(undefined);
  const [draft, setDraft] = useState(() => load(node, effects, 0));
  const fresh = JSON.stringify(node, null, 2);
  let owned = draft;

  if (draft.effects !== effects || draft.path !== node.$path) {
    nextGeneration.current += 1;
    owned = load(node, effects, nextGeneration.current);
    setDraft(owned);
  } else if (!draft.busy && draft.text === draft.baseline && draft.baseline !== fresh) {
    owned = load(node, effects, draft.generation);
    setDraft(owned);
  }
  current.current.generation = owned.generation;
  const generation = owned.generation;
  useEffect(() => {
    current.current.mounted = true;
    return () => { current.current.mounted = false; };
  }, [generation]);
  const bits = effects.bits(node.$path) ?? 0;
  const dirty = owned.text !== owned.baseline;

  /** Retained callbacks never become valid again after a source or path round trip. */
  function assertOwner(): void {
    if (!current.current.mounted || current.current.generation !== generation) throw new KernelError('CANCELLED', 'The editor owner changed');
  }

  /** Form fields retain the complete node, including every untouched component and loaded revision. */
  function edit(value: Node): void {
    assertOwner();
    if (pending.current?.generation === generation) throw new KernelError('UNAVAILABLE', 'The editor save is pending');
    setDraft(previous => ({ ...previous, node: value, text: JSON.stringify(value, null, 2), error: undefined }));
  }

  /** Decode user JSON before replacing the form draft. */
  function editJson(text: string): void {
    assertOwner();
    if (pending.current?.generation === generation) throw new KernelError('UNAVAILABLE', 'The editor save is pending');
    try {
      const value: unknown = JSON.parse(text);
      if (!isNode(value) || value.$path !== owned.path) throw new KernelError('INVALID', 'A node at the loaded path is required');
      setDraft(previous => ({ ...previous, text, node: value, error: undefined }));
    } catch (reason) {
      setDraft(previous => ({ ...previous, text, error: reason instanceof Error ? reason.message : String(reason) }));
    }
  }

  /** Put the visible full node under its loaded revision; the server preserves hidden administration metadata. */
  async function save(): Promise<void> {
    assertOwner();
    if (pending.current?.generation === generation) return;
    const token = Symbol('editor-save');
    pending.current = { generation, token };
    setDraft(previous => ({ ...previous, busy: true, error: undefined }));
    try {
      const value: unknown = JSON.parse(owned.text);
      if (!isNode(value) || value.$path !== owned.path) throw new KernelError('INVALID', 'A loaded node revision is required');
      const { $id, $rev, $pos, ...input } = value;
      if (!isNodeInput(input)) throw new KernelError('INVALID', 'Invalid full node input');
      const kernel = effects.kernel;
      if (kernel === undefined) throw new KernelError('UNAVAILABLE', 'Canonical editing requires a native source');
      await pendingSave?.settle();
      assertOwner();
      pendingSave?.discard();
      await kernel.commit({ changes: [{ op: 'put', node: input }], expect: { nodes: [{ path: input.$path, rev: owned.baseRev }] } });
      assertOwner();
      setDraft(previous => ({ ...previous, baseline: owned.text, busy: false }));
    } catch (reason) {
      if (!current.current.mounted || current.current.generation !== generation) return;
      setDraft(previous => ({ ...previous, busy: false, error: reason instanceof Error ? reason.message : String(reason), errorCode: reason instanceof KernelError ? reason.code : undefined }));
    } finally {
      if (pending.current?.token === token) pending.current = undefined;
    }
  }

  /** ACL edits share the full-node buffer and its original OCC revision. */
  function editAcl(owner: Principal | undefined, rules: readonly AclEntry[]): void {
    const { $owner, ...withoutOwner } = owned.node;
    edit({ ...withoutOwner, ...(owner === undefined ? {} : { $owner: owner }), $acl: rules });
  }

  if (!open) return null;
  return <section aria-label="Node editor" className="flex min-w-0 flex-col gap-3 p-4">
    <div className="flex items-center justify-between"><h2>{node.$path}</h2><Button onClick={onClose}>Close editor</Button></div>
    <p className="text-xs text-muted-foreground">Revision {owned.baseRev}{dirty && owned.baseline !== fresh ? ' · changed since loaded' : ''}</p>
    {owned.error !== undefined && <p role="alert" data-error-code={owned.errorCode} className="text-red-600">{owned.error}</p>}
    <div className="flex gap-2"><Button onClick={() => setDraft(previous => ({ ...previous, mode: 'properties' }))}>Properties</Button>
      <Button onClick={() => setDraft(previous => ({ ...previous, mode: 'json' }))}>JSON</Button></div>
    <fieldset disabled={owned.busy} className="flex min-w-0 flex-col gap-3">
    {owned.mode === 'json' ? <JsonEditor value={owned.text} onChange={editJson} /> : <>
      <AclEditor bits={bits} owner={owned.node.$owner} rules={owned.node.$acl ?? []} onChange={editAcl} />
      {componentEntries(owned.node).map(([name, value]) => <section key={`${generation}:${name}`} aria-label={name || 'Main component'}>
        <h3>{name || value.$type}</h3><ComponentPanel path={owned.path} name={name} value={value} onChange={(field, fieldValue) => {
          const replacement = { ...owned.node };
          if (name === '') Reflect.set(replacement, field, fieldValue);
          else Reflect.set(replacement, name, { ...value, [field]: fieldValue });
          edit(replacement);
        }} />
        {name !== '' && (bits & W) !== 0 && <Button onClick={() => {
          const replacement = { ...owned.node }; Reflect.deleteProperty(replacement, name); edit(replacement);
        }}>Remove component</Button>}
      </section>)}
    </>}
    </fieldset>
    <div className="flex gap-2"><Button onClick={() => { void save(); }} disabled={owned.busy || !dirty || (bits & W) === 0}>Save node</Button>
      <Button disabled={owned.busy} onClick={() => { assertOwner(); if (pending.current?.generation === generation) return; setDraft(load(node, effects, generation)); }}>Reset</Button>
      {(bits & A) !== 0 && onAddComponent !== undefined && <Button disabled={owned.busy} onClick={() => onAddComponent(node.$path)}>Add component</Button>}
      {(bits & W) !== 0 && onDelete !== undefined && <Button disabled={owned.busy} onClick={onDelete}>Delete node</Button>}</div>
  </section>;
}
