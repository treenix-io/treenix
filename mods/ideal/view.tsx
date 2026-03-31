import { view } from '@treenity/react/view';
import { useActions } from '@treenity/react/context';
import { Idea } from './types';

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

view.list(Idea, ({ value }) => (
  <div className="flex items-center gap-2 px-2 py-1">
    <span className="text-xs px-1.5 py-0.5 rounded bg-muted">{value.votes}</span>
    <span>{value.title}</span>
  </div>
));
