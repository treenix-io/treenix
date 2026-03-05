// Inspector — view + edit panel for selected node (Unity-style inspector)
// Shell only: delegates rendering to registered views, provides generic edit UI

import { NodeProvider, Render, RenderContext } from '#context';
import {
  getActions,
  getActionSchema,
  getComponents,
  getPlainFields,
  getSchema,
  getViewContexts,
  pickDefaultContext,
} from '#mods/editor-ui/node-utils';
import { type ComponentData, type GroupPerm, type NodeData, resolve } from '@treenity/core/core';
import { renderField, StringArrayField } from '#mods/editor-ui/form-field';
import type { TypeSchema } from '@treenity/core/schema/types';
import { useEffect, useRef, useState } from 'react';
import { AclEditor } from './AclEditor';
import * as cache from './cache';
import { ErrorBoundary } from './ErrorBoundary';
import { set, usePath } from './hooks';
import { useSchema } from './schema-loader';
import { trpc } from './trpc';

type AnyClass = { new(): Record<string, unknown> };

type Props = {
  path: string | null;
  currentUserId?: string;
  onDelete: (path: string) => void;
  onAddComponent: (path: string) => void;
  onSelect: (path: string) => void;
  onSetRoot?: (path: string) => void;
  toast: (msg: string) => void;
};

// Breadcrumb from path
function Breadcrumb({ path, onSelect }: { path: string; onSelect: (p: string) => void }) {
  if (path === '/')
    return (
      <div className="editor-breadcrumb">
        <span>/</span>
      </div>
    );
  const parts = path.split('/').filter(Boolean);
  const crumbs: { label: string; path: string }[] = [{ label: '/', path: '/' }];
  let cur = '';
  for (const p of parts) {
    cur += '/' + p;
    crumbs.push({ label: p, path: cur });
  }
  return (
    <div className="editor-breadcrumb">
      {crumbs.map((c, i) => (
        <span key={c.path}>
          {i > 0 && <span className="sep">/</span>}
          <span onClick={() => onSelect(c.path)}>{c.label === '/' ? 'root' : c.label}</span>
        </span>
      ))}
    </div>
  );
}

// Pretty-print action result value
function ResultView({ value }: { value: unknown }) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object')
    return <span className="font-mono text-[11px]">{String(value)}</span>;

  // Object/array with typed $type → render via Render
  if ('$type' in (value as any)) {
    return <Render value={value as ComponentData} />;
  }

  // Plain object — key/value pairs
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return <span className="text-muted-foreground text-[11px]">empty</span>;

  return (
    <div className="flex flex-col gap-0.5">
      {entries.map(([k, v]) => (
        <div key={k} className="flex gap-2 text-[11px]">
          <span className="text-muted-foreground shrink-0">{k}</span>
          <span className="font-mono text-foreground/80 truncate">
            {typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '')}
          </span>
        </div>
      ))}
    </div>
  );
}

// Action pills — compact action buttons that expand on click
function ActionCardList({
  path,
  componentName,
  compType,
  toast,
  onActionComplete,
}: {
  path: string;
  componentName: string;
  compType: string;
  compData: Record<string, unknown>;
  toast: (msg: string) => void;
  onActionComplete?: () => void;
}) {
  const schema = useSchema(compType);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [paramsText, setParamsText] = useState<Record<string, string>>({});
  const [schemaData, setSchemaData] = useState<Record<string, Record<string, unknown>>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { ok: boolean; value: unknown }>>({});
  const [resultMode, setResultMode] = useState<Record<string, 'pretty' | 'json'>>({});

  if (schema === undefined) return null;

  const actions = getActions(compType, schema);
  if (actions.length === 0) return null;

  async function run(a: string) {
    setRunning(a);
    try {
      const actionSchema = getActionSchema(compType, a);
      let data: unknown = {};
      if (actionSchema) {
        data = schemaData[a] ?? {};
      } else {
        const raw = (paramsText[a] ?? '').trim();
        if (raw && raw !== '{}') {
          try { data = JSON.parse(raw); }
          catch { toast('Invalid JSON params'); setRunning(null); return; }
        }
      }
      const result = await trpc.execute.mutate({ path, key: componentName, action: a, data });
      const fresh = (await trpc.get.query({ path, watch: true })) as NodeData | undefined;
      if (fresh) cache.put(fresh);
      onActionComplete?.();
      setResults((prev) => ({ ...prev, [a]: { ok: true, value: result } }));
      setExpanded(a);
    } catch (e) {
      setResults((prev) => ({
        ...prev,
        [a]: { ok: false, value: e instanceof Error ? e.message : String(e) },
      }));
      setExpanded(a);
    } finally {
      setRunning(null);
    }
  }

  return (
    <div className="action-pills">
      <div className="flex flex-wrap gap-1.5">
        {actions.map((a) => (
          <button
            key={a}
            className={`action-pill${expanded === a ? ' active' : ''}${running === a ? ' running' : ''}`}
            onClick={() => setExpanded(expanded === a ? null : a)}
          >
            {running === a ? '...' : a}
            {results[a] && !results[a].ok && expanded !== a && (
              <span className="ml-1 text-destructive">!</span>
            )}
            {results[a]?.ok && expanded !== a && (
              <span className="ml-1 text-primary/60">✓</span>
            )}
          </button>
        ))}
      </div>

      {expanded && (() => {
        const a = expanded;
        const actionSchema = getActionSchema(compType, a);
        const hasParams = actionSchema !== null && Object.keys(actionSchema.properties).length > 0;
        const noParams = actionSchema !== null && Object.keys(actionSchema.properties).length === 0;
        const result = results[a];
        const mode = resultMode[a] ?? 'pretty';

        return (
          <div className="action-detail">
            {/* Params section */}
            {hasParams && (
              <div className="flex flex-col gap-1.5 mb-2">
                {Object.entries(actionSchema!.properties).map(([field, prop]) => {
                  const p = prop as { type: string; title?: string; format?: string };
                  const val = (schemaData[a] ?? {})[field];
                  const setField = (v: unknown) =>
                    setSchemaData((prev) => ({
                      ...prev,
                      [a]: { ...(prev[a] ?? {}), [field]: v },
                    }));
                  return (
                    <div key={field} className="action-detail-field">
                      <label>{p.title ?? field}</label>
                      {p.type === 'number' || p.format === 'number' ? (
                        <input type="number" value={String(val ?? 0)}
                          onChange={(e) => setField(Number(e.target.value))} />
                      ) : p.type === 'boolean' ? (
                        <label className="flex items-center gap-1.5 cursor-pointer">
                          <input type="checkbox" checked={!!val} className="w-auto"
                            onChange={(e) => setField(e.target.checked)} />
                          <span className="text-[11px]">{val ? 'true' : 'false'}</span>
                        </label>
                      ) : (
                        <input value={String(val ?? '')}
                          onChange={(e) => setField(e.target.value)} />
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Free-form JSON params for untyped actions */}
            {!hasParams && !noParams && (
              <textarea
                className="action-params-input mb-2"
                value={paramsText[a] ?? '{}'}
                onChange={(e) => setParamsText((prev) => ({ ...prev, [a]: e.target.value }))}
                spellCheck={false}
                rows={2}
              />
            )}

            {/* Run button */}
            <button
              className="action-run-btn"
              disabled={running !== null}
              onClick={() => run(a)}
            >
              {running === a ? '...' : '▶'} {a}
            </button>

            {/* Result */}
            {result && (
              <div className={`action-result-box${result.ok ? '' : ' error'}`}>
                {!result.ok ? (
                  <span className="text-destructive font-mono text-[11px]">{String(result.value)}</span>
                ) : result.value === undefined || result.value === null ? (
                  <span className="text-primary text-[11px]">✓ done</span>
                ) : (
                  <>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Result</span>
                      {typeof result.value === 'object' && (
                        <div className="flex gap-0.5">
                          <button
                            className={`action-mode-btn${mode === 'pretty' ? ' active' : ''}`}
                            onClick={() => setResultMode((p) => ({ ...p, [a]: 'pretty' }))}
                          >View</button>
                          <button
                            className={`action-mode-btn${mode === 'json' ? ' active' : ''}`}
                            onClick={() => setResultMode((p) => ({ ...p, [a]: 'json' }))}
                          >JSON</button>
                        </div>
                      )}
                    </div>
                    {mode === 'json' ? (
                      <pre className="text-[11px] font-mono text-foreground/60 whitespace-pre-wrap break-all leading-relaxed">
                        {JSON.stringify(result.value, null, 2)}
                      </pre>
                    ) : (
                      <ResultView value={result.value} />
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}



function NodeCard({
  path,
  type,
  onChangeType,
}: {
  path: string;
  type: string;
  onChangeType: (t: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card">
      <div
        className="card-header cursor-pointer select-none"
        onClick={() => setOpen((v) => !v)}
      >
        <span>Node</span>
        <span className="flex items-center gap-2 normal-case tracking-normal font-normal text-[11px] font-mono text-foreground/50">
          {path}
          <span className="text-primary">{type}</span>
          {open ? (
            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6"/></svg>
          ) : (
            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6"/></svg>
          )}
        </span>
      </div>
      {open && (
        <div className="card-body">
          <div className="field">
            <label>$path</label>
            <input value={path} readOnly />
          </div>
          <div className="field">
            <label>$type</label>
            <input value={type} onChange={(e) => onChangeType(e.target.value)} />
          </div>
        </div>
      )}
    </div>
  );
}


export function Inspector({ path, currentUserId, onDelete, onAddComponent, onSelect, onSetRoot, toast }: Props) {
  const node = usePath(path);

  const [context, setContext] = useState('react');
  const [editing, setEditing] = useState(false);
  const [nodeType, setNodeType] = useState('');
  const [compTexts, setCompTexts] = useState<Record<string, string>>({});
  const [compData, setCompData] = useState<Record<string, Record<string, unknown>>>({});
  const [plainData, setPlainData] = useState<Record<string, unknown>>({});
  const [tab, setTab] = useState<'properties' | 'json'>('properties');
  const [jsonText, setJsonText] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [aclOwner, setAclOwner] = useState('');
  const [aclRules, setAclRules] = useState<GroupPerm[]>([]);
  const [dirty, setDirty] = useState(false);
  const [stale, setStale] = useState(false);
  const syncedPathRef = useRef<string | null>(null);
  const syncedRevRef = useRef<unknown>(null);

  function syncFromNode(n: NodeData) {
    setNodeType(n.$type);
    setAclOwner((n.$owner as string) ?? '');
    setAclRules(n.$acl ? [...(n.$acl as GroupPerm[])] : []);
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
    setCompTexts(texts);
    setCompData(cdata);
    setPlainData(getPlainFields(n));
    setJsonText(JSON.stringify(n, null, 2));
    setTab('properties');
  }

  useEffect(() => {
    if (!node) return;

    const pathChanged = node.$path !== syncedPathRef.current;
    if (pathChanged) {
      setContext(pickDefaultContext(node.$type));
      syncFromNode(node);
      syncedPathRef.current = node.$path;
      syncedRevRef.current = node.$rev;
      setDirty(false);
      setStale(false);
      return;
    }

    if (node.$rev !== syncedRevRef.current) {
      if (dirty) {
        setStale(true);
      } else {
        syncFromNode(node);
        syncedRevRef.current = node.$rev;
      }
    }
  }, [node?.$path, node?.$rev]);

  // Dirty-tracking wrappers — mark form as edited on any user change
  const dSetNodeType: typeof setNodeType = (v) => { setNodeType(v); setDirty(true); };
  const dSetCompData: typeof setCompData = (v) => { setCompData(v); setDirty(true); };
  const dSetPlainData: typeof setPlainData = (v) => { setPlainData(v); setDirty(true); };
  const dSetJsonText: typeof setJsonText = (v) => { setJsonText(v); setDirty(true); };
  const dSetAclOwner: typeof setAclOwner = (v) => { setAclOwner(v); setDirty(true); };
  const dSetAclRules: typeof setAclRules = (v) => { setAclRules(v); setDirty(true); };

  function handleReset() {
    if (!node) return;
    const current = cache.get(node.$path) ?? node;
    syncFromNode(current);
    syncedRevRef.current = current.$rev;
    setDirty(false);
    setStale(false);
  }

  if (!node) {
    return (
      <div className="editor">
        <div className="editor-empty">
          <div className="icon">&#9741;</div>
          <p>Select a node to inspect</p>
        </div>
      </div>
    );
  }

  const nodeName = node.$path === '/' ? '/' : node.$path.slice(node.$path.lastIndexOf('/') + 1);
  const components = getComponents(node);
  const viewContexts = getViewContexts(node.$type, node);
  const schemaHandler = resolve(node.$type, 'schema');
  const schema = schemaHandler ? (schemaHandler() as TypeSchema) : null;

  // Main component: when the node IS the component (its $type has a registered class).
  // Show the class's fields (with defaults as fallback for unset fields).
  const mainCompCls = resolve(node.$type, 'class') as AnyClass | null;
  const mainCompDefaults = mainCompCls ? new mainCompCls() : null;

  async function handleSave() {
    if (!node) return;
    let toSave: NodeData;
    if (tab === 'json') {
      try {
        toSave = JSON.parse(jsonText);
      } catch {
        toast('Invalid JSON');
        return;
      }
    } else {
      toSave = { $path: node.$path, $type: nodeType, ...plainData };
      if (aclOwner) toSave.$owner = aclOwner;
      if (aclRules.length > 0) toSave.$acl = aclRules;
      for (const [name, comp] of components) {
        const ctype = (comp as ComponentData).$type;
        const cschema = getSchema(ctype);
        const cd = compData[name];
        if ((cschema || (cd && Object.keys(cd).length > 0)) && cd) {
          toSave[name] = { $type: ctype, ...cd };
        } else {
          const text = compTexts[name];
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
      syncedRevRef.current = fresh.$rev;
    }
    setDirty(false);
    setStale(false);
    toast('Saved');
  }

  function handleAdd() {
    if (!node) return;
    onAddComponent(node.$path);
  }

  function handleRemoveComponent(name: string) {
    if (!node) return;
    const next = { ...node };
    delete next[name];
    set(next);
  }

  function toggleCollapse(name: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  return (
    <div className="editor">
      {/* Header */}
      <div className="editor-header">
        <Breadcrumb path={node.$path} onSelect={onSelect} />
        <div className="editor-title">
          <h2>{nodeName}</h2>
          <span className="editor-type-badge">{node.$type}</span>
          <a
            href={node.$path}
            target="_blank"
            rel="noopener"
            className="text-[11px] text-[--text-3] hover:text-[--accent] no-underline"
          >
            View &#8599;
          </a>
          {onSetRoot && (
            <button
              className="sm ghost text-[11px]"
              onClick={() => onSetRoot(node.$path)}
              title="Focus subtree"
            >
              &#8962;
            </button>
          )}
          {viewContexts.length > 1 && (
            <span className="context-buttons">
              {viewContexts.map((c) => (
                <button
                  key={c}
                  className={`sm context-btn${context === c ? ' active' : ''}`}
                  onClick={() => setContext(c)}
                >
                  {c.replace('react:', '')}
                </button>
              ))}
            </span>
          )}
          <span className="spacer" />
          <button className={editing ? 'sm' : 'sm primary'} onClick={() => setEditing(!editing)}>
            {editing ? 'Close' : 'Edit'}
          </button>
          <button
            className="sm danger"
            onClick={() => {
              if (confirm(`Delete ${node.$path}?`)) onDelete(node.$path);
            }}
          >
            Delete
          </button>
        </div>
      </div>

      {/* Rendered view */}
      <div className="editor-body">
        <ErrorBoundary>
          <RenderContext name={context}>
            <div className="node-view">
              <Render value={node} />
            </div>
          </RenderContext>
        </ErrorBoundary>
      </div>

      {/* Slide-out edit panel */}
      <div className={`edit-panel${editing ? ' open' : ''}`}>
        <div className="edit-panel-header">
          <span>Edit {nodeName}</span>
          <button className="sm ghost" onClick={() => setEditing(false)}>
            &#10005;
          </button>
        </div>

        <div className="edit-panel-tabs">
          <button
            className={`editor-tab${tab === 'properties' ? ' active' : ''}`}
            onClick={() => setTab('properties')}
          >
            Properties
          </button>
          <button
            className={`editor-tab${tab === 'json' ? ' active' : ''}`}
            onClick={() => {
              setTab('json');
              setJsonText(JSON.stringify({ ...node, ...plainData }, null, 2));
            }}
          >
            JSON
          </button>
        </div>

        <div className="edit-panel-body">
          {tab === 'properties' ? (
            <>
              <NodeCard path={node.$path} type={nodeType} onChangeType={dSetNodeType} />

              <AclEditor
                path={node.$path}
                owner={aclOwner}
                rules={aclRules}
                currentUserId={currentUserId}
                onChange={(o, r) => {
                  dSetAclOwner(o);
                  dSetAclRules(r);
                }}
              />

              {(mainCompCls || schema) && (
                <div className="card">
                  <div className="card-header">{node.$type}</div>
                  <ErrorBoundary>
                    <ComponentBody
                      ctype={node.$type}
                      cdata={plainData}
                      setCD={(fn) => dSetPlainData(fn)}
                      path={node.$path}
                      componentName=""
                      toast={toast}
                      onActionComplete={handleReset}
                    />
                  </ErrorBoundary>
                </div>
              )}

              {components.map(([name, comp]) => (
                <div key={name} className="card">
                  <div className="card-header cursor-pointer select-none" onClick={() => toggleCollapse(name)}>
                    <span className="font-mono text-[12px]">{name}</span>
                    <span className="flex items-center gap-2">
                      <span className="component-type">{(comp as ComponentData).$type}</span>
                      <button
                        className="sm danger"
                        onClick={(e) => { e.stopPropagation(); handleRemoveComponent(name); }}
                      >
                        Remove
                      </button>
                    </span>
                  </div>
                  {!collapsed.has(name) && (
                    <ErrorBoundary>
                      <RenderContext name="react:edit">
                        <Render
                          value={{ $type: (comp as ComponentData).$type, ...(compData[name] ?? {}) } as ComponentData}
                          onChange={(next: ComponentData) => {
                            const d: Record<string, unknown> = {};
                            for (const [k, v] of Object.entries(next as Record<string, unknown>)) {
                              if (!k.startsWith('$')) d[k] = v;
                            }
                            dSetCompData((prev) => ({ ...prev, [name]: d }));
                          }}
                        />
                      </RenderContext>
                      <ActionCardList
                        path={node.$path}
                        componentName={name}
                        compType={(comp as ComponentData).$type}
                        compData={compData[name] ?? {}}
                        toast={toast}
                        onActionComplete={handleReset}
                      />
                    </ErrorBoundary>
                  )}
                </div>
              ))}

              {!schema && !mainCompDefaults && Object.keys(plainData).length > 0 && (
                <div className="card">
                  <div className="card-header">Data</div>
                  <div className="card-body">
                    {Object.entries(plainData).map(([k, v]) => (
                      <div key={k} className="field">
                        <label>{k}</label>
                        <input
                          value={typeof v === 'string' ? v : JSON.stringify(v)}
                          onChange={(e) =>
                            dSetPlainData((prev) => ({ ...prev, [k]: e.target.value }))
                          }
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="json-view">
              <textarea
                value={jsonText}
                onChange={(e) => dSetJsonText(e.target.value)}
                spellCheck={false}
              />
            </div>
          )}
        </div>

        <div className="edit-panel-actions">
          {stale && (
            <button className="ghost" onClick={handleReset} title="Node updated externally">
              Reset
            </button>
          )}
          <button className="primary" onClick={handleSave}>
            Save
          </button>
          {tab === 'properties' && (
            <button onClick={handleAdd}>+ Component</button>
          )}
        </div>
      </div>
    </div>
  );
}
