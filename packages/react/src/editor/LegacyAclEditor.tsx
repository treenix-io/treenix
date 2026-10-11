import { Button } from '#components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '#components/ui/collapsible';
import { Input } from '#components/ui/input';
import { A, type GroupPerm, R, S, W } from '@treenx/core';
import { ChevronRight, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { tree } from '#tree/client';

const BITS = [
  { bit: R, label: 'R' },
  { bit: W, label: 'W' },
  { bit: A, label: 'A' },
  { bit: S, label: 'S' },
] as const;

function permStr(p: number): string {
  return (
    BITS.filter((b) => p & b.bit)
      .map((b) => b.label)
      .join('') || '—'
  );
}

type Props = {
  path: string;
  owner: string;
  rules: GroupPerm[];
  currentUserId?: string;
  onChange: (owner: string, rules: GroupPerm[]) => void;
};

type InheritedEntry = { path: string; owner?: string; acl?: GroupPerm[] };

// Ancestor paths strictly ABOVE `path` (excludes the node itself; '/' has none).
function ancestorPaths(path: string): string[] {
  if (path === '/') return [];
  const segs = path.split('/').filter(Boolean);
  const paths = ['/'];
  let cur = '';
  for (let i = 0; i < segs.length - 1; i++) {
    cur += '/' + segs[i];
    paths.push(cur);
  }
  return paths;
}

/** Preserve legacy ACL entry editing without recomputing permissions on the client. */
export function LegacyAclEditor({ path, owner, rules, currentUserId, onChange }: Props) {
  const [newGroup, setNewGroup] = useState('');
  const [chain, setChain] = useState<InheritedEntry[]>([]);

  // Fetch ancestors (not just whatever's cached) so the inherited chain is complete
  // for deep nodes whose mid-ancestors were never loaded into the tree cache.
  useEffect(() => {
    let cancelled = false;
    const paths = ancestorPaths(path);
    Promise.all(paths.map((p) => tree.get(p).catch((e: unknown) => {
      // Unreadable ancestors (FORBIDDEN/NOT_FOUND) are expected — the chain
      // renders with what's visible. Anything else is a real fetch failure;
      // don't hide it behind a silently shorter inherited chain (core-pfy).
      const code = (e as { data?: { code?: string }; code?: string })?.data?.code
        ?? (e as { code?: string })?.code;
      if (code !== 'NOT_FOUND' && code !== 'FORBIDDEN') {
        console.warn('[AclEditor] ancestor fetch failed:', p, e);
      }
      return undefined;
    }))).then((nodes) => {
      if (cancelled) return;
      const next: InheritedEntry[] = [];
      paths.forEach((p, i) => {
        const node = nodes[i];
        if (node && (node.$acl || node.$owner)) next.push({ path: p, owner: node.$owner, acl: node.$acl });
      });
      setChain(next);
    });
    return () => { cancelled = true; };
  }, [path]);

  function toggleBit(idx: number, bit: number) {
    const next = [...rules];
    next[idx] = { ...next[idx], p: next[idx].p ^ bit };
    onChange(owner, next);
  }

  function removeRule(idx: number) {
    onChange(
      owner,
      rules.filter((_, i) => i !== idx),
    );
  }

  function addRule() {
    if (!newGroup.trim()) return;
    onChange(owner, [...rules, { g: newGroup.trim(), p: R }]);
    setNewGroup('');
  }

  return (
    <Collapsible className="border-t border-border mt-2 pt-0.5 first:border-t-0 first:mt-0 first:pt-0">
      <CollapsibleTrigger className="flex w-full items-center justify-between py-2 pb-1.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider cursor-pointer select-none">
        <span>Access Control</span>
        <span className="flex items-center gap-2 normal-case tracking-normal font-normal">
          <ChevronRight className="h-3 w-3 transition-transform duration-200 group-data-[state=open]:rotate-90" />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="py-0.5 pb-2.5 space-y-3">
          {chain.length > 0 && (
            <div className="space-y-1">
              <span className="text-[11px] text-muted-foreground/60 uppercase tracking-wide">Inherited</span>
              <div className="space-y-1.5 pl-2 border-l border-border/40">
                {chain.map((entry) => (
                  <div key={entry.path} className="text-[11px] font-mono">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="truncate text-muted-foreground">{entry.path}</span>
                      {entry.owner && (
                        <span className="text-foreground/50 text-[10px] shrink-0">owner={entry.owner}</span>
                      )}
                    </div>
                    {entry.acl && entry.acl.length > 0 && (
                      <div className="mt-0.5 flex flex-wrap items-center gap-1">
                        {entry.acl.map((r, i) => (
                          <span
                            key={i}
                            className="inline-flex items-center gap-1.5 rounded bg-secondary px-1.5 py-0.5"
                          >
                            <span className="text-muted-foreground">{r.g}</span>
                            <span className={r.p === 0 ? 'text-destructive' : 'text-primary'}>
                              {permStr(r.p)}
                            </span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="field">
            <label className="text-xs text-muted-foreground">$owner</label>
            <Input className="h-7 text-xs" value={owner} onChange={(e) => onChange(e.target.value, rules)} />
          </div>

          {rules.length > 0 && (
            <AclTable
              rules={rules}
              editable
              onToggleBit={toggleBit}
              onRemove={removeRule}
            />
          )}
          <div className="flex gap-2">
            <Input
              className="h-7 text-xs"
              placeholder="Group name"
              value={newGroup}
              onChange={(e) => setNewGroup(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addRule()}
            />
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={addRule}>
              Add
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ── Reusable ACL table ──

function AclTable({
  rules,
  editable,
  onToggleBit,
  onRemove,
}: {
  rules: GroupPerm[];
  editable?: boolean;
  onToggleBit?: (i: number, bit: number) => void;
  onRemove?: (i: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      {rules.map((rule, i) => (
        <div
          key={i}
          className="flex items-center gap-2 px-1 py-0.5"
        >
          <span className="flex-1 text-[12px] font-mono text-foreground/70 truncate">
            {rule.g}
          </span>
          <span className="flex items-center gap-0.5">
            {BITS.map(({ bit, label }) => {
              const active = !!(rule.p & bit);
              return editable ? (
                <button
                  key={label}
                  type="button"
                  onClick={() => onToggleBit?.(i, bit)}
                  className={`text-[10px] font-mono font-bold w-6 h-5 rounded transition-colors ${
                    active
                      ? 'text-primary bg-primary/15 border border-primary/30'
                      : 'text-muted-foreground/40 bg-transparent border border-transparent hover:border-border'
                  }`}
                >
                  {label}
                </button>
              ) : (
                <span
                  key={label}
                  className={`text-[10px] font-mono font-bold w-6 text-center ${
                    active ? 'text-primary' : 'text-muted-foreground/20'
                  }`}
                >
                  {label}
                </span>
              );
            })}
          </span>
          {editable && (
            <button
              type="button"
              className="text-muted-foreground/40 hover:text-destructive transition-colors p-0.5"
              onClick={() => onRemove?.(i)}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
