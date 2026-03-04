// ViewPage — standalone read-only node view at /{path}

import { Render, RenderContext } from '#context';
import { usePath } from './hooks';

export function ViewPage({ path, editorLink }: { path: string; editorLink?: boolean }) {
  const node = usePath(path);

  const name = path === '/' ? '/' : path.slice(path.lastIndexOf('/') + 1);

  if (!node) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-4 text-[--text-3]">
        <div className="text-4xl">404</div>
        <p>Node not found: <span className="font-mono">{path}</span></p>
        {editorLink && <a href={`/t${path}`} className="text-[--accent] hover:underline">Open in editor</a>}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen">
      {editorLink && (
        <div className="flex items-center gap-3 px-4 py-2 border-b border-[--border] bg-[--bg-2]">
          <span className="font-semibold text-sm">{name}</span>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[--accent]/10 text-[--accent]">
            {node.$type}
          </span>
          <span className="flex-1" />
          <a
            href={`/t${path}`}
            className="text-xs text-[--text-3] hover:text-[--text-1] no-underline"
          >
            Open in editor
          </a>
        </div>
      )}
      <div className="flex-1 overflow-auto p-4 has-[.view-full]:p-0">
        <RenderContext name="react">
          <Render value={node} />
        </RenderContext>
      </div>
    </div>
  );
}
