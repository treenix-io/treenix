// Tags form handler — react:form for "tags" format

import { Badge } from '#components/ui/badge';
import { Button } from '#components/ui/button';
import { Input } from '#components/ui/input';
import { register } from '@treenx/core';
import { X } from 'lucide-react';
import { useState } from 'react';

type FP = {
  value: { $type: string; value: unknown; label?: string };
  onChange?: (next: any) => void;
};

function TagsForm({ value, onChange }: FP) {
  const [input, setInput] = useState('');
  const tags: string[] = Array.isArray(value.value) ? value.value : [];

  function add() {
    const t = input.trim();
    if (!t || tags.includes(t)) return;
    onChange?.({ ...value, value: [...tags, t] });
    setInput('');
  }

  function remove(tag: string) {
    onChange?.({ ...value, value: tags.filter((t) => t !== tag) });
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {tags.map((tag) => (
          <Badge key={tag} variant="secondary" className="gap-1 pr-1">
            {tag}
            <button
              type="button"
              onClick={() => remove(tag)}
              className="ml-0.5 rounded-full hover:bg-destructive/20 hover:text-destructive p-0.5"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
        {tags.length === 0 && <span className="text-xs text-muted-foreground">No groups</span>}
      </div>
      <div className="flex gap-2">
        <Input
          className="flex-1"
          placeholder="Add group..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())}
        />
        <Button variant="outline" size="sm" type="button" onClick={add}>
          Add
        </Button>
      </div>
    </div>
  );
}

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

export function registerGroups() {
  register('tags', 'react:form', TagsForm as any);
  register('tags', 'react:compact', TagsView as any);
  register('tags', 'react', TagsView as any);
}
