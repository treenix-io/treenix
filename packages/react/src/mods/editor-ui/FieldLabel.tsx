// FieldLabel — interactive label for Inspector fields
// Click → dropdown menu (value/$ref/$map + copy/clear), drop target for tree nodes

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '#components/ui/dropdown-menu';
import { Input } from '#components/ui/input';
import { isRef } from '@treenx/core';
import { useState } from 'react';

type FieldMode = 'value' | 'ref' | 'map';

function getFieldMode(v: unknown): FieldMode {
  if (v && typeof v === 'object' && isRef(v)) {
    return (v as { $map?: string }).$map !== undefined ? 'map' : 'ref';
  }
  return 'value';
}

const MODE_LABELS: Record<FieldMode, string> = { value: 'val', ref: '$ref', map: '$map' };

/** Interactive field label — click for mode menu, drop target for tree nodes */
export function FieldLabel({ label, value, onChange }: {
  label: string;
  value: unknown;
  onChange?: (next: unknown) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const mode = getFieldMode(value);

  function switchMode(next: FieldMode) {
    if (!onChange || next === mode) return;
    if (next === 'value') {
      onChange(0);
    } else if (next === 'ref') {
      onChange({ $ref: '.' });
    } else {
      const r = isRef(value) ? (value as { $ref: string }).$ref : '.';
      onChange({ $ref: r, $map: '' });
    }
  }

  if (!onChange) {
    return (
      <label className="block overflow-hidden text-ellipsis" title={label}>
        {label}
      </label>
    );
  }

  return (
    <label
      className={dragOver ? 'text-primary cursor-pointer' : 'cursor-pointer'}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/treenix-path')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const path = e.dataTransfer.getData('application/treenix-path');
        if (path && onChange) {
          const existing = isRef(value) ? (value as { $map?: string }).$map : undefined;
          onChange(existing !== undefined ? { $ref: path, $map: existing } : { $ref: path });
        }
      }}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <span className="block overflow-hidden text-ellipsis" title={label}>
            {label}
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[100px]">
          {(['value', 'ref', 'map'] as FieldMode[]).map((m) => (
            <DropdownMenuItem key={m} onClick={() => switchMode(m)}>
              {mode === m ? '\u25CF ' : '\u00A0\u00A0'}{MODE_LABELS[m]}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => navigator.clipboard.writeText(JSON.stringify(value))}>
            Copy
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onChange(undefined)}>
            Clear
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </label>
  );
}

/** Inline ref/map editor — $ref + optional $map, compact single/double row */
export function RefEditor({ value, onChange }: {
  value: { $ref: string; $map?: string };
  onChange: (next: unknown) => void;
}) {
  const hasMap = value.$map !== undefined;

  return (
    <div className="flex flex-col gap-1 flex-1 min-w-0">
      <div className="flex items-center gap-1">
        <span className="text-[9px] text-muted-foreground shrink-0 w-5">$ref</span>
        <Input
          className="h-7 text-xs flex-1 min-w-0"
          value={value.$ref}
          onChange={(e) => onChange(hasMap ? { $ref: e.target.value, $map: value.$map } : { $ref: e.target.value })}
          placeholder="path"
        />
      </div>
      {hasMap && (
        <div className="flex items-center gap-1">
          <span className="text-[9px] text-muted-foreground shrink-0 w-5">$map</span>
          <Input
            className="h-7 text-xs flex-1 min-w-0"
            value={value.$map ?? ''}
            onChange={(e) => onChange({ $ref: value.$ref, $map: e.target.value })}
            placeholder="field"
          />
        </div>
      )}
    </div>
  );
}
