// Mind map sidebar — shows selected node details
// Lightweight panel: path, type, components, fields, actions

import { execute, usePath } from '@treenity/react/hooks';
import { getActions, getComponents, getPlainFields, getSchema } from '@treenity/react/mods/editor-ui/node-utils';

type Props = {
  path: string;
  onClose: () => void;
  onNavigate: (path: string) => void;
};

function shortType(type: string): string {
  const parts = type.split('.');
  return parts.length > 1 ? parts.slice(-1)[0] : type;
}

export function MindMapSidebar({ path, onClose, onNavigate }: Props) {
  const node = usePath(path);

  if (!node) {
    return (
      <div className="mm-sidebar">
        <div className="mm-sidebar-header">
          <span className="text-[var(--text-3)]">Loading...</span>
          <button className="mm-btn" onClick={onClose}>&times;</button>
        </div>
      </div>
    );
  }

  const components = getComponents(node);
  const fields = getPlainFields(node);
  const schema = getSchema(node.$type);
  const actions = getActions(node.$type, schema);

  return (
    <div className="mm-sidebar">
      <div className="mm-sidebar-header">
        <div className="flex flex-col gap-0.5 min-w-0">
          <span
            className="text-[13px] font-semibold truncate cursor-pointer hover:underline"
            onClick={() => onNavigate(path)}
            title="Open in Inspector"
          >
            {path.split('/').at(-1) || '/'}
          </span>
          <span className="text-[11px] text-[var(--text-3)] truncate">{path}</span>
        </div>
        <button className="mm-btn shrink-0" onClick={onClose}>&times;</button>
      </div>

      <div className="mm-sidebar-body">
        {/* Type */}
        <div className="mm-section">
          <div className="mm-section-label">Type</div>
          <span className="mm-type-badge">{node.$type}</span>
        </div>

        {/* Fields */}
        {Object.keys(fields).length > 0 && (
          <div className="mm-section">
            <div className="mm-section-label">Fields</div>
            <div className="flex flex-col gap-1">
              {Object.entries(fields).map(([k, v]) => (
                <div key={k} className="mm-field-row">
                  <span className="mm-field-key">{k}</span>
                  <span className="mm-field-val">
                    {typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Components */}
        {components.length > 0 && (
          <div className="mm-section">
            <div className="mm-section-label">Components ({components.length})</div>
            <div className="flex flex-col gap-1.5">
              {components.map(([key, comp]) => (
                <div key={key} className="mm-comp-card">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[12px] font-medium">{key}</span>
                    <span className="mm-comp-type">{shortType((comp as any).$type)}</span>
                  </div>
                  <div className="flex flex-col gap-0.5 mt-1">
                    {Object.entries(comp)
                      .filter(([k]) => !k.startsWith('$'))
                      .slice(0, 5)
                      .map(([k, v]) => (
                        <div key={k} className="mm-field-row">
                          <span className="mm-field-key">{k}</span>
                          <span className="mm-field-val">
                            {typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')}
                          </span>
                        </div>
                      ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Actions */}
        {actions.length > 0 && (
          <div className="mm-section">
            <div className="mm-section-label">Actions</div>
            <div className="flex flex-wrap gap-1">
              {actions.map(a => (
                <button
                  key={a}
                  className="mm-action-btn"
                  onClick={() => execute(path, a).catch(console.error)}
                >
                  {a}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
