import { isRecord } from '@treenx/core/util/is-record';
import { KernelError } from '@treenx/core/errors';
import type { NativeTypeDescription } from '@treenx/core/kernel/type-description';
import { useState } from 'react';
import { useTreeEffects } from '#hooks';
import { useNativeTypeDescription } from '#schema-loader';
import { Button } from '#components/ui/button';
import { NativeSchemaForm } from './NativeSchemaFields';
import { JsonEditor } from '#mods/editor-ui/JsonEditor';

/** Invoke only actual described actions through the selected source's captured effect owner. */
function ActionBody({ path, type, component, description }: ActionProps & { description: NativeTypeDescription }) {
  const effects = useTreeEffects();
  const [selected, setSelected] = useState<string>();
  const [text, setText] = useState('{}');
  const [fields, setFields] = useState<Record<string, unknown>>({});
  const [mode, setMode] = useState<'fields' | 'json'>('fields');
  const [result, setResult] = useState<unknown>();
  const [error, setError] = useState<string>();

  /** Decode user arguments before sending the exact request to canonical action admission. */
  async function run(): Promise<void> {
    if (selected === undefined) return;
    try {
      const args: unknown = JSON.parse(text);
      const value = await effects.execute(path, selected, args, type, component);
      setResult(value); setError(undefined);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  return <section aria-label="Actions" className="space-y-2">
    <div className="flex flex-wrap gap-2">{Object.entries(description.actions).map(([name, action]) =>
      <Button key={name} onClick={() => { setSelected(name); setText('{}'); setFields({}); setMode('fields'); }}>{name} · {action.kind}</Button>)}</div>
    {selected !== undefined && <><div className="flex gap-2"><Button onClick={() => { try { const value: unknown = JSON.parse(text); if (!isRecord(value)) throw new KernelError('INVALID', 'Action arguments must be an object for field editing'); setFields(value); setMode('fields'); setError(undefined); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } }}>Argument fields</Button><Button onClick={() => setMode('json')}>Argument JSON</Button></div>{mode === 'fields' && description.actions[selected].args.properties !== undefined && <NativeSchemaForm schema={description.actions[selected].args} value={fields}
      onChange={(name, value) => { const next = { ...fields, [name]: value }; setFields(next); setText(JSON.stringify(next)); }} />}{(mode === 'json' || description.actions[selected].args.properties === undefined) && <JsonEditor value={text} onChange={value => { setText(value); setError(undefined); }} />}<Button onClick={() => { void run(); }}>Run {selected}</Button></>}
    {error !== undefined && <p role="alert">{error}</p>}
    {result !== undefined && <pre>{JSON.stringify(result, null, 2)}</pre>}
  </section>;
}

interface ActionProps { path: string; type: string; component?: string; description?: NativeTypeDescription }

/** Fetch action metadata only when a containing component does not already own its description. */
function DescribedActions(props: ActionProps) {
  const description = useNativeTypeDescription(props.type);
  return description === undefined ? null : <ActionBody {...props} description={description} />;
}

/** Share one full description between a component's fields and actions without a registry cache. */
export function NativeActionCards(props: ActionProps) {
  return props.description === undefined ? <DescribedActions {...props} /> : <ActionBody {...props} description={props.description} />;
}
