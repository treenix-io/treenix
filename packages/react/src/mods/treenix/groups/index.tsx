// Compact tags display; editable tags belong to the shared form fields.

import { Badge } from '#components/ui/badge';
import { declareClientModule } from '#context/client-registry';

type FP = {
  value: { $type: string; value: unknown; label?: string };
  onChange?: (next: any) => void;
};



function TagsView({ value }: FP) {
  const tags: string[] = Array.isArray(value?.value) ? (value.value as string[]) : [];
  if (tags.length === 0) return <span className="text-xs text-muted-foreground">—</span>;

  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((tag) => (
        <Badge key={tag} variant="secondary" className="text-xs">
          {tag}
        </Badge>
      ))}
    </div>
  );
}

export default declareClientModule('@treenx/react/treenix/groups', [
  { type: 'tags', context: 'react:compact', handler: TagsView },
]);
