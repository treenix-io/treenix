import { type NodeData, register } from '@treenx/core';
import { pathName } from './list-items';
import { getComponents, getSchema } from './node-utils';

function UserView({ value }: { value: NodeData }) {
  const id = pathName(value.$path);
  const groups = value.groups as { $type: string; list: string[] } | undefined;
  const comps = getComponents(value).filter(([n]) => n !== 'groups' && n !== 'credentials');

  return (
    <div className="node-default-view">
      <div className="flex items-center gap-4 mb-4">
        <div className="flex size-14 shrink-0 items-center justify-center rounded-full bg-primary text-[22px] font-bold text-primary-foreground">
          {id.charAt(0).toUpperCase()}
        </div>
        <div>
          <div className="text-[16px] font-semibold text-foreground">{id}</div>
          {groups?.list && groups.list.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {groups.list.map((g) => (
                <span
                  key={g}
                  className="rounded-full border border-primary/25 bg-primary/10 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-primary"
                >
                  {g}
                </span>
              ))}
            </div>
          )}
          {value.$owner && (
            <div className="mt-1 text-[11px] text-muted-foreground">
              owner: {String(value.$owner)}
            </div>
          )}
        </div>
      </div>
      {comps.map(([name, comp]) => {
        const ctype = (comp as any).$type;
        const s = getSchema(ctype);
        const fields = s ? Object.entries(s.properties) : [];
        return (
          <div key={name} className="comp-view-card">
            <div className="comp-view-header">
              {name}
              {name !== ctype && <span className="comp-type">{ctype}</span>}
            </div>
            {fields.length > 0
              ? fields.map(([k, prop]) => {
                  const val = (comp as any)[k];
                  return (
                    <div key={k} className="comp-view-row">
                      <span className="comp-view-label">{(prop as any).title}</span>
                      <span className="comp-view-value">
                        {val === undefined || val === ''
                          ? '—'
                          : typeof val === 'object'
                            ? JSON.stringify(val)
                            : String(val)}
                      </span>
                    </div>
                  );
                })
              : Object.entries(comp)
                  .filter(([k]) => !k.startsWith('$'))
                  .map(([k, v]) => (
                    <div key={k} className="comp-view-row">
                      <span className="comp-view-label">{k}</span>
                      <span className="comp-view-value">
                        {typeof v === 'string' ? v || '—' : JSON.stringify(v)}
                      </span>
                    </div>
                  ))}
          </div>
        );
      })}
    </div>
  );
}

register('user', 'react', UserView as any);
