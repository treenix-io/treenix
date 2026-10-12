import { useEffect, useState } from 'react';
import { A, R, W, type AclEntry, type Principal, type Node } from '@treenx/core/kernel/types';
import { isNodeInput } from '@treenx/core/protocol/twp';
import { Button } from '#components/ui/button';
import { Input } from '#components/ui/input';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '#components/ui/collapsible';
import { ChevronRight, X } from 'lucide-react';
import { usePath } from '#hooks';

const BITS = [
  { bit: R, label: 'R' },
  { bit: W, label: 'W' },
  { bit: A, label: 'A' },
] as const;

export interface AclEditorProps {
  readonly path?: string;
  readonly bits: number;
  readonly owner?: Principal;
  readonly rules: readonly AclEntry[];
  readonly onChange: (owner: Principal | undefined, rules: readonly AclEntry[]) => void;
}

/** Show the actual ancestor declarations; effective rights remain owned by the server. */
function InheritedAccess({ path }: { path: string }) {
  const { data: node, error } = usePath<Node>(path);
  if (error !== null)
    return (
      <p role="alert" className="text-xs text-destructive">
        {path}: {error.message}
      </p>
    );
  if (node === undefined || (node.$owner === undefined && node.$acl === undefined)) return null;

  return (
    <div className="text-[11px] font-mono">
      <div className="flex items-center gap-2 min-w-0">
        <span className="truncate text-muted-foreground">{path}</span>
        {node.$owner !== undefined && (
          <span className="text-foreground/50 text-[10px] shrink-0">owner={node.$owner}</span>
        )}
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-1">
        {node.$acl?.map((entry, index) => (
          <span
            key={index}
            className="inline-flex items-center gap-1.5 rounded bg-secondary px-1.5 py-0.5"
          >
            <span className="text-muted-foreground">
              {'group' in entry.subject ? entry.subject.group : 'Owner'}
            </span>
            <span className={'deny' in entry ? 'text-destructive' : 'text-primary'}>
              {'deny' in entry ? '−' : '+'}
              {BITS.map(({ bit, label }) =>
                (('grant' in entry ? entry.grant : entry.deny) & bit) !== 0 ? label : '',
              ).join('') || '—'}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Edit canonical entries only when the actual server copy grants administration. */
export function AclEditor({ path, bits, owner, rules, onChange }: AclEditorProps) {
  const [group, setGroup] = useState('');
  const [ownerText, setOwnerText] = useState(owner ?? '');
  const [error, setError] = useState<string>();
  useEffect(() => {
    setOwnerText(owner ?? '');
  }, [owner]);
  if ((bits & A) === 0) return null;

  function toggle(index: number, bit: number): void {
    onChange(
      owner,
      rules.map((entry, position) =>
        position !== index
          ? entry
          : 'grant' in entry
            ? { subject: entry.subject, grant: entry.grant ^ bit }
            : { subject: entry.subject, deny: entry.deny ^ bit },
      ),
    );
  }

  function add(ownerSubject = false): void {
    const name = group.trim();
    if (!ownerSubject && name.length === 0) return;
    onChange(owner, [
      ...rules,
      { subject: ownerSubject ? { owner: true } : { group: name }, grant: R },
    ]);
    setGroup('');
  }

  /** Validate the user's principal input with the existing canonical node boundary. */
  function editOwner(value: string): void {
    const input = { $path: '/', $type: 'dir', ...(value.length === 0 ? {} : { $owner: value }) };
    if (!isNodeInput(input)) {
      setError('Invalid owner principal');
      return;
    }
    setError(undefined);
    onChange(input.$owner, rules);
  }

  const ancestors: string[] = [];
  if (path !== undefined && path !== '/') {
    ancestors.push('/');
    const parts = path.split('/').filter(Boolean);
    let ancestor = '';
    for (const part of parts.slice(0, -1)) {
      ancestor += `/${part}`;
      ancestors.push(ancestor);
    }
  }

  return (
    <Collapsible
      aria-label="Access control"
      className="border-t border-border mt-2 pt-0.5 first:border-t-0 first:mt-0 first:pt-0"
    >
      <CollapsibleTrigger className="group flex w-full items-center justify-between py-2 pb-1.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider cursor-pointer select-none">
        <span>Access Control</span>
        <ChevronRight className="h-3 w-3 transition-transform duration-200 group-data-[state=open]:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="py-0.5 pb-2.5 space-y-3">
          {ancestors.length > 0 && (
            <div className="space-y-1">
              <span className="text-[11px] text-muted-foreground/60 uppercase tracking-wide">
                Inherited
              </span>
              <div className="space-y-1.5 pl-2 border-l border-border/40">
                {ancestors.map((path) => (
                  <InheritedAccess key={path} path={path} />
                ))}
              </div>
            </div>
          )}
          <div className="field">
            <label className="text-xs text-muted-foreground">$owner</label>
            <Input
              aria-label="Owner"
              className="h-7 text-xs"
              value={ownerText}
              onChange={(event) => setOwnerText(event.target.value)}
              onBlur={() => editOwner(ownerText)}
            />
          </div>
          {error !== undefined && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-col gap-1">
            {rules.map((entry, index) => (
              <div key={index} className="flex items-center gap-2 px-1 py-0.5">
                <span className="flex-1 text-[12px] font-mono text-foreground/70 truncate">
                  {'group' in entry.subject ? entry.subject.group : 'Owner'}
                </span>
                <select
                  className="text-[10px] bg-transparent text-muted-foreground"
                  aria-label={`Rule ${index + 1} mode`}
                  value={'grant' in entry ? 'grant' : 'deny'}
                  onChange={(event) =>
                    onChange(
                      owner,
                      rules.map((rule, position) =>
                        position !== index
                          ? rule
                          : event.target.value === 'grant'
                            ? {
                                subject: rule.subject,
                                grant: 'grant' in rule ? rule.grant : rule.deny,
                              }
                            : {
                                subject: rule.subject,
                                deny: 'grant' in rule ? rule.grant : rule.deny,
                              },
                      ),
                    )
                  }
                >
                  <option value="grant">Grant</option>
                  <option value="deny">Deny</option>
                </select>
                <span className="flex items-center gap-0.5">
                  {BITS.map(({ bit, label }) => (
                    <button
                      key={label}
                      type="button"
                      aria-label={`Rule ${index + 1} ${label}`}
                      aria-pressed={Boolean(('grant' in entry ? entry.grant : entry.deny) & bit)}
                      className={`text-[10px] font-mono font-bold w-6 h-5 rounded transition-colors ${
                        (('grant' in entry ? entry.grant : entry.deny) & bit) !== 0
                          ? 'text-primary bg-primary/15 border border-primary/30'
                          : 'text-muted-foreground/40 bg-transparent border border-transparent hover:border-border'
                      }`}
                      onClick={() => toggle(index, bit)}
                    >
                      {label}
                    </button>
                  ))}
                </span>
                <button
                  type="button"
                  className="text-muted-foreground/40 hover:text-destructive transition-colors p-0.5"
                  aria-label={`Remove rule ${index + 1}`}
                  onClick={() =>
                    onChange(
                      owner,
                      rules.filter((_, position) => position !== index),
                    )
                  }
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <Input
              aria-label="Group"
              className="h-7 text-xs"
              placeholder="Group name"
              value={group}
              onChange={(event) => setGroup(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') add();
              }}
            />
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => add()}>
              Add
            </Button>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => add(true)}>
              Owner
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
