import { Button } from '#components/ui/button';
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '#components/ui/command';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '#components/ui/dialog';
import { Input } from '#components/ui/input';
import { typeFilter } from '#lib/string-utils';
import { trpc } from '#tree/trpc';
import { isOfType, type NodeData } from '@treenx/core';
import { useEffect, useMemo, useRef, useState } from 'react';

export type TypeInfo = { type: string; label: string; description: string };

export async function loadTypes(): Promise<TypeInfo[]> {
  const { items } = (await trpc.getChildren.query({ path: '/sys/types', limit: 0, depth: 99 })) as {
    items: NodeData[];
    total: number;
  };
  return items
    .filter((n) => isOfType(n, 'type'))
    .map((n) => {
      const schema = n.schema as { $type: string; title?: string; description?: string } | undefined;
      const typeName = n.$path.slice('/sys/types/'.length).replace(/\//g, '.');
      return {
        type: typeName,
        label: schema?.title ?? typeName,
        description: schema?.description ?? '',
      };
    });
}

function groupByNamespace(types: TypeInfo[]): Map<string, TypeInfo[]> {
  const groups = new Map<string, TypeInfo[]>();
  for (const t of types) {
    const dotIdx = t.type.indexOf('.');
    const ns = dotIdx === -1 ? 'core' : t.type.slice(0, dotIdx);
    if (!groups.has(ns)) groups.set(ns, []);
    groups.get(ns)!.push(t);
  }
  return groups;
}

export function TypePicker({
  onSelect,
  onCancel,
  title = 'Create Node',
  nameLabel = 'Node name',
  action = 'Create',
  autoName = false,
}: {
  onSelect: (name: string, type: string) => void;
  onCancel: () => void;
  title?: string;
  nameLabel?: string;
  action?: string;
  autoName?: boolean;
}) {
  const [types, setTypes] = useState<TypeInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [nameManual, setNameManual] = useState(false);
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadTypes()
      .then(setTypes)
      .catch((err) => {
        console.error('Failed to load types:', err);
        setError('Failed to load types');
      })
      .finally(() => setLoading(false));
  }, []);

  const visibleTypes = useMemo(() => {
    const s = search.trim();
    if (!s) return types;
    return types
      .map((t) => ({ ...t, score: typeFilter(t.type, s, [t.label, t.description].filter(Boolean)) }))
      .filter((t) => t.score > 0)
      .sort((a, b) => b.score - a.score);
  }, [search, types]);

  function handleSelectType(type: string) {
    setSelectedType(type);
    if (autoName && !nameManual) {
      const lastSegment = type.includes('.') ? type.slice(type.lastIndexOf('.') + 1) : type;
      setName(lastSegment);
    }
    requestAnimationFrame(() => {
      nameRef.current?.focus();
      nameRef.current?.select();
    });
  }

  function handleSubmit() {
    if (name && selectedType) onSelect(name, selectedType);
  }

  const groups = groupByNamespace(visibleTypes);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="p-0 gap-0 max-w-[380px] overflow-hidden" showCloseButton={false}>
        <DialogHeader className="px-4 pt-4 pb-2">
          <DialogTitle className="text-[15px]">{title}</DialogTitle>
        </DialogHeader>

        <Command className="rounded-none border-none" shouldFilter={false}>
          <CommandInput placeholder="Search types..." onValueChange={setSearch} />
          <CommandList className="max-h-[280px]">
            {loading && <div className="p-3 text-muted-foreground text-[13px]">Loading types...</div>}
            {error && <div className="p-3 text-destructive text-[13px]">{error}</div>}
            {!loading && visibleTypes.length === 0 && (
              <div className="py-6 text-center text-sm text-muted-foreground">No types found</div>
            )}
            {[...groups.entries()].map(([ns, items]) => (
              <CommandGroup key={ns} heading={ns}>
                {items.map((t) => (
                  <CommandItem
                    key={t.type}
                    value={t.type}
                    onSelect={() => handleSelectType(t.type)}
                    className={selectedType === t.type ? 'bg-accent text-accent-foreground' : ''}
                  >
                    <div className="flex flex-col gap-0.5">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[13px]">{t.type}</span>
                        {t.label !== t.type && <span className="text-muted-foreground text-[12px]">{t.label}</span>}
                      </div>
                      {t.description && (
                        <span className="text-[11px] text-muted-foreground/60 leading-tight">{t.description}</span>
                      )}
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>

        <div className="px-4 py-3 border-t border-border">
          <Input
            ref={nameRef}
            className="h-8 text-sm"
            placeholder={nameLabel}
            value={name}
            onChange={(e) => { setName(e.target.value); setNameManual(true); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleSubmit(); } }}
          />
        </div>

        <DialogFooter className="px-4 pb-4">
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button disabled={!name || !selectedType} onClick={handleSubmit}>
            {action}
            {name ? ` "${name}"` : ''}
            {selectedType ? ` as ${selectedType}` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
