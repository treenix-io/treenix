import { Button } from '#components/ui/button';
import { Input } from '#components/ui/input';
import { A, type GroupPerm, R, S, W } from '@treenity/core/core';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import * as cache from './cache';

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

// Compute claims for userId from cache (mirrors server buildClaims — no 'public' for authenticated)
function getUserClaims(userId: string): Set<string> {
  const claims = new Set([`u:${userId}`, 'authenticated']);
  const userNode = cache.get(`/auth/users/${userId}`);
  if (userNode) {
    const groups = userNode.groups as { list?: string[] } | undefined;
    if (groups?.list) groups.list.forEach((g) => claims.add(g));
  }
  return claims;
}

// Mirrors server resolvePermission: walk root→node accumulating allow/deny per group.
// Allow rules cascade down; deny is sticky (once denied, can't be re-allowed).
function computeEffective(
  currentNodeOwner: string,
  currentNodeRules: GroupPerm[],
  userId: string,
  path: string,
): { perms: number; matchedGroups: string[] } {
  const claims = getUserClaims(userId);

  // All paths from root → current node inclusive
  const allPaths =
    path === '/'
      ? ['/']
      : [
          '/',
          ...path
            .split('/')
            .filter(Boolean)
            .reduce<string[]>((acc, seg) => {
              acc.push((acc.length ? acc[acc.length - 1] : '') + '/' + seg);
              return acc;
            }, []),
        ];

  const groupPerms = new Map<string, number>();
  const denied = new Set<string>();
  const deniedBits = new Map<string, number>();
  let resolvedOwner = '';

  for (const p of allPaths) {
    let nodeOwner: string | undefined;
    let nodeRules: GroupPerm[] | undefined;

    if (p === path) {
      // Current node: use local (possibly unsaved) state
      nodeOwner = currentNodeOwner || undefined;
      nodeRules = currentNodeRules;
    } else {
      const cached = cache.get(p);
      if (!cached) continue;
      nodeOwner = cached.$owner as string | undefined;
      nodeRules = cached.$acl as GroupPerm[] | undefined;
    }

    if (nodeOwner) resolvedOwner = nodeOwner;
    if (!nodeRules || nodeRules.length === 0) continue;

    for (const { g, p: perm } of nodeRules) {
      const matches = g === 'owner' ? userId === resolvedOwner : claims.has(g);
      if (!matches) continue;
      if (denied.has(g)) continue;
      if (perm < 0) {
        const bits = -perm;
        deniedBits.set(g, (deniedBits.get(g) || 0) | bits);
      } else if (perm === 0) {
        denied.add(g);
        groupPerms.set(g, 0);
      } else {
        groupPerms.set(g, perm & ~(deniedBits.get(g) || 0));
      }
    }
  }

  let effective = 0;
  const matchedGroups: string[] = [];
  for (const [g, p] of groupPerms.entries()) {
    if (p > 0) matchedGroups.push(g);
    if (p > effective) effective = p;
  }
  return { perms: effective, matchedGroups };
}

type Props = {
  path: string;
  owner: string;
  rules: GroupPerm[];
  currentUserId?: string;
  onChange: (owner: string, rules: GroupPerm[]) => void;
};

function ancestorChain(path: string): { path: string; owner?: string; acl?: GroupPerm[] }[] {
  const parts =
    path === '/'
      ? ['/']
      : [
          '/',
          ...path
            .split('/')
            .filter(Boolean)
            .reduce<string[]>((acc, seg) => {
              acc.push((acc.length ? acc[acc.length - 1] : '') + '/' + seg);
              return acc;
            }, []),
        ];
  const chain: { path: string; owner?: string; acl?: GroupPerm[] }[] = [];
  for (const p of parts) {
    const node = cache.get(p);
    if (node && (node.$acl || node.$owner))
      chain.push({ path: p, owner: node.$owner, acl: node.$acl });
  }
  return chain;
}

export function AclEditor({ path, owner, rules, currentUserId, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [newGroup, setNewGroup] = useState('');
  const chain = useMemo(() => ancestorChain(path), [path]);

  const effective = currentUserId ? computeEffective(owner, rules, currentUserId, path) : null;

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
    <div className="card">
      <div
        className="card-header cursor-pointer select-none"
        onClick={() => setOpen((v) => !v)}
      >
        <span>Access Control</span>
        <span className="flex items-center gap-2 normal-case tracking-normal font-normal">
          {effective && (
            <span className="flex items-center gap-1.5">
              {effective.matchedGroups.length > 0 && (
                <span className="text-[10px] font-mono text-muted-foreground/60 truncate max-w-[120px]">
                  {effective.matchedGroups[effective.matchedGroups.length - 1]}
                </span>
              )}
              <span className="flex items-center gap-0.5">
                {BITS.map(({ bit, label }) => (
                  <span
                    key={label}
                    className={`text-[10px] font-mono font-bold px-1 rounded ${
                      effective.perms & bit
                        ? 'text-primary bg-primary/10'
                        : 'text-muted-foreground/30'
                    }`}
                  >
                    {label}
                  </span>
                ))}
              </span>
            </span>
          )}
          {open ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </span>
      </div>
      {open && (
        <div className="card-body space-y-3">
          <div className="field">
            <label className="text-xs text-muted-foreground">$owner</label>
            <Input value={owner} onChange={(e) => onChange(e.target.value, rules)} />
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
              placeholder="Group name"
              value={newGroup}
              onChange={(e) => setNewGroup(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addRule()}
            />
            <Button variant="outline" size="sm" onClick={addRule}>
              Add
            </Button>
          </div>

          {chain.length > 0 && (
            <div className="space-y-1.5 pt-1 border-t border-border/40">
              <span className="text-[11px] text-muted-foreground/60 uppercase tracking-wide">Inherited</span>
              <div className="space-y-1.5 pl-2 border-l border-border/40">
                {chain.map((entry) => (
                  <div key={entry.path} className="text-xs min-w-0">
                    <div className="flex items-baseline gap-1.5 min-w-0 font-mono text-muted-foreground">
                      <span className="truncate shrink-0 max-w-[55%]">{entry.path}</span>
                      {entry.owner && (
                        <span className="truncate text-foreground/50 text-[10px]">owner={entry.owner}</span>
                      )}
                    </div>
                    {entry.acl && entry.acl.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-0.5">
                        {entry.acl.map((r, i) => (
                          <span
                            key={i}
                            className="inline-flex items-center gap-0.5 rounded bg-secondary px-1.5 py-0.5 text-[11px]"
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
        </div>
      )}
    </div>
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
          className="flex items-center gap-2 px-2 py-1.5 rounded bg-background border border-border/60"
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
