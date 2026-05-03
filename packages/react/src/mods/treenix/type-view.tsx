// Type node views — react + react:list + live preview

import { getContextsForType, type NodeData, register } from '@treenx/core';
import { TypePreview } from './preview';

// ── Helpers ──

function typeName(path: string) {
  return path.replace(/^\/sys\/types\//, '').replace(/\//g, '.');
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">{children}</div>;
}

// ── react (full view with live preview) ──

function TypeNodeView({ value }: { value: NodeData }) {
  const name = typeName(value.$path);
  const schema = value.schema as Record<string, unknown> | undefined;
  const title = schema?.title ? String(schema.title) : null;
  const props = (schema?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const contexts = getContextsForType(name);
  const components = Object.keys(value).filter(k => !k.startsWith('$') && k !== 'schema');

  return (
    <div className="max-w-xl space-y-4">
      {title && <div className="text-lg font-semibold">{title}</div>}

      {Object.keys(props).length > 0 && (
        <div>
          <SectionLabel>Properties</SectionLabel>
          <div className="flex flex-col gap-1">
            {Object.entries(props).map(([k, v]) => (
              <div key={k} className="flex gap-2 text-sm px-2 py-1 bg-muted rounded">
                <span className="font-mono text-primary">{k}</span>
                <span className="text-muted-foreground">{String(v.type ?? 'string')}</span>
                {typeof v.label === 'string' && <span className="text-muted-foreground ml-auto">{v.label}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {components.length > 0 && (
        <div>
          <SectionLabel>Components</SectionLabel>
          <div className="flex flex-wrap gap-1.5">
            {components.map(c => (
              <span key={c} className="px-2.5 py-0.5 rounded-full text-xs font-mono bg-muted border border-border text-muted-foreground">{c}</span>
            ))}
          </div>
        </div>
      )}

      {contexts.length > 0 && (
        <div>
          <SectionLabel>Contexts</SectionLabel>
          <div className="flex flex-wrap gap-1.5">
            {contexts.map(c => (
              <span key={c} className="px-2.5 py-0.5 rounded-full text-xs font-mono bg-muted border border-border text-muted-foreground">{c}</span>
            ))}
          </div>
        </div>
      )}

      <div>
        <SectionLabel>Preview</SectionLabel>
        <TypePreview key={name} typeName={name} properties={props} />
      </div>
    </div>
  );
}

// ── react:list (compact) ──

function TypeListItem({ value }: { value: NodeData }) {
  const name = typeName(value.$path);
  const schema = value.schema as Record<string, unknown> | undefined;
  const title = schema?.title ? String(schema.title) : null;
  const description = schema?.description ? String(schema.description) : null;
  const props = Object.keys((schema?.properties ?? {}) as object);
  const methods = Object.keys((schema?.methods ?? {}) as object);
  const hasClass = !!value.class;

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-sm">{name}</span>
        {hasClass && (
          <span className="text-[10px] px-1.5 py-px rounded bg-primary/10 text-primary">class</span>
        )}
      </div>
      {(title || description) && (
        <div className="text-xs text-muted-foreground mt-0.5">
          {title}{title && description ? ' — ' : ''}{description}
        </div>
      )}
      {(props.length > 0 || methods.length > 0) && (
        <div className="flex gap-1 mt-1 flex-wrap">
          {props.map(p => (
            <span key={p} className="text-[11px] px-1.5 py-px rounded bg-muted text-muted-foreground font-mono">{p}</span>
          ))}
          {methods.map(m => (
            <span key={m} className="text-[11px] px-1.5 py-px rounded bg-muted text-primary font-mono">{m}()</span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Registration ──

register('type', 'react', TypeNodeView as any);
register('type', 'react:list', TypeListItem as any);
