import { declareClientModule } from '#context/client-registry';
import type { View } from '#context';
import { Render } from '#context';
import { usePath } from '#hooks';

const RootView: View<{ $type: 'root' }> = () => {
  const { data: page, loading } = usePath('/home');

  if (loading) return null;

  if (!page) {
    return (
      <div className="flex items-center justify-center h-full text-neutral-500 text-sm">
        Node <code className="mx-1 text-primary/70 font-mono">/home</code> not found — create a node at that path.
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <Render value={page} />
    </div>
  );
};

export default declareClientModule('@treenx/react/treenix/root-view', [
  { type: 'root', context: 'react', handler: RootView }
]);
