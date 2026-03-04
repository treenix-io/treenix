import { type NodeData, register } from '@treenity/core/core';
import { pathName } from './list-items';
import { getComponents, getSchema } from './node-utils';

function UserView({ value }: { value: NodeData }) {
  const id = pathName(value.$path);
  const groups = value.groups as { $type: string; list: string[] } | undefined;
  const comps = getComponents(value).filter(([n]) => n !== 'groups' && n !== 'credentials');

  return (
    <div className="node-default-view">
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 16 }}>
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: '50%',
            background: 'var(--accent)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 22,
            fontWeight: 700,
            color: '#fff',
            flexShrink: 0,
          }}
        >
          {id.charAt(0).toUpperCase()}
        </div>
        <div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{id}</div>
          {groups?.list && groups.list.length > 0 && (
            <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
              {groups.list.map((g) => (
                <span
                  key={g}
                  style={{
                    padding: '2px 10px',
                    borderRadius: 12,
                    background: 'var(--accent-subtle)',
                    color: 'var(--accent)',
                    fontSize: 11,
                    fontWeight: 500,
                  }}
                >
                  {g}
                </span>
              ))}
            </div>
          )}
          {value.$owner && (
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
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
