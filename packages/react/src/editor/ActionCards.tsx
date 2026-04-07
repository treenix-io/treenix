// ActionCards — action pill buttons with expandable params, run, and results

import { Button } from '#components/ui/button';
import { Checkbox } from '#components/ui/checkbox';
import { Input } from '#components/ui/input';
import { Render } from '#context';
import { execute } from '#hooks';
import { getActions, getActionSchema } from '#mods/editor-ui/node-utils';
import { useSchema } from '#schema-loader';
import * as cache from '#tree/cache';
import { trpc } from '#tree/trpc';
import type { ComponentData, NodeData } from '@treenity/core';
import { useState } from 'react';

function ResultView({ value }: { value: unknown }) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object')
    return <span className="font-mono text-[11px]">{String(value)}</span>;

  if ('$type' in (value as Record<string, unknown>)) {
    return <Render value={value as ComponentData} />;
  }

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

export function ActionCardList({
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
      const result = await execute(path, a, data, undefined, componentName);
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
    <div className="mt-2.5 pt-2.5 border-t border-border">
      <div className="flex flex-wrap gap-1.5">
        {actions.map((a) => (
          <Button
            key={a}
            variant="outline"
            size="sm"
            className={`h-6 rounded-full font-mono text-[11px] text-green-300 bg-green-400/10 border-green-400/40 hover:bg-green-400/20 hover:border-green-400/60 ${expanded === a ? 'bg-green-400/20 border-green-300' : ''} ${running === a ? 'opacity-60 pointer-events-none' : ''}`}
            onClick={() => setExpanded(expanded === a ? null : a)}
          >
            {running === a ? '...' : a}
            {results[a] && !results[a].ok && expanded !== a && (
              <span className="ml-1 text-destructive">!</span>
            )}
            {results[a]?.ok && expanded !== a && (
              <span className="ml-1 text-primary/60">✓</span>
            )}
          </Button>
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
          <div className="mt-2 p-2 px-2.5 border border-border rounded-md bg-card">
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
                    <div key={field} className="flex flex-col gap-0.5">
                      <label>{p.title ?? field}</label>
                      {p.type === 'number' || p.format === 'number' ? (
                        <Input type="number" className="h-7 text-xs" value={String(val ?? 0)}
                          onChange={(e) => setField(Number(e.target.value))} />
                      ) : p.type === 'boolean' ? (
                        <label className="flex items-center gap-1.5 cursor-pointer">
                          <Checkbox checked={!!val}
                            onChange={(e) => setField((e.target as HTMLInputElement).checked)} />
                          <span className="text-[11px]">{val ? 'true' : 'false'}</span>
                        </label>
                      ) : (
                        <Input className="h-7 text-xs" value={String(val ?? '')}
                          onChange={(e) => setField(e.target.value)} />
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {!hasParams && !noParams && (
              <textarea
                className="min-h-12 text-[11px] mb-2"
                value={paramsText[a] ?? '{}'}
                onChange={(e) => setParamsText((prev) => ({ ...prev, [a]: e.target.value }))}
                spellCheck={false}
                rows={2}
              />
            )}

            <Button
              size="sm"
              className="h-6 rounded-full text-[11px] font-medium"
              disabled={running !== null}
              onClick={() => run(a)}
            >
              {running === a ? '...' : '▶'} {a}
            </Button>

            {result && (
              <div className={`mt-2 p-1.5 px-2 rounded-md bg-background border ${result.ok ? 'border-border' : 'border-destructive/40 bg-destructive/5'}`}>
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
                          <Button
                            variant={mode === 'pretty' ? 'secondary' : 'ghost'}
                            size="sm"
                            className="h-5 px-1.5 text-[10px] rounded-full"
                            onClick={() => setResultMode((p) => ({ ...p, [a]: 'pretty' }))}
                          >View</Button>
                          <Button
                            variant={mode === 'json' ? 'secondary' : 'ghost'}
                            size="sm"
                            className="h-5 px-1.5 text-[10px] rounded-full"
                            onClick={() => setResultMode((p) => ({ ...p, [a]: 'json' }))}
                          >JSON</Button>
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
