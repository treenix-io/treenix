import { Render, RenderContext, useActions, useChildren, view } from '@treenx/react';
import { Idea, IdeasBoard } from './types';

// ── Board view — renders children in list context ──

view(IdeasBoard, ({ value, ctx }) => {
  const { data: children } = useChildren(ctx.path);

  return (
    <div className="p-4 space-y-3">
      <h1 className="text-xl font-bold">Ideas Board</h1>
      <p className="text-sm text-muted-foreground">
        Auto-approve at {value.autoApproveThreshold}+ votes
      </p>

      <RenderContext name="react:list">
        <div className="divide-y divide-border rounded-md border border-border">
          {children.map(child => (
            <Render key={child.$path} value={child} />
          ))}
        </div>
      </RenderContext>
    </div>
  );
});

// ── Idea — full view ──

view(Idea, ({ value }) => {
  const { upvote, approve, reject } = useActions(value);

  return (
    <div className="p-4 space-y-2">
      <h2 className="text-lg font-bold">{value.title}</h2>
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">{value.votes} votes</span>
        <span className="text-xs px-2 py-0.5 rounded-full bg-muted">{value.status}</span>
      </div>
      <div className="flex gap-2">
        <button className="px-3 py-1 text-sm bg-primary text-primary-foreground rounded" onClick={() => upvote()}>+1</button>
        {value.status === 'new' && (
          <>
            <button className="px-3 py-1 text-sm bg-green-600 text-white rounded" onClick={() => approve()}>Approve</button>
            <button className="px-3 py-1 text-sm bg-red-600 text-white rounded" onClick={() => reject()}>Reject</button>
          </>
        )}
      </div>
    </div>
  );
});

// ── Idea — compact list row ──

view.list(Idea, ({ value }) => (
  <div className="flex items-center gap-2 px-3 py-2">
    <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-muted">{value.votes}</span>
    <span className="flex-1">{value.title}</span>
    <span className="text-xs text-muted-foreground">{value.status}</span>
  </div>
));
