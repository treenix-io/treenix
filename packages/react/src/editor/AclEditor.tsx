import { useEffect, useState } from 'react';
import { A, R, W, type AclEntry, type Principal } from '@treenx/core/kernel/types';
import { isNodeInput } from '@treenx/core/protocol/twp';
import { Button } from '#components/ui/button';
import { Input } from '#components/ui/input';

const BITS = [{ bit: R, label: 'R' }, { bit: W, label: 'W' }, { bit: A, label: 'A' }] as const;

export interface AclEditorProps {
  readonly bits: number;
  readonly owner?: Principal;
  readonly rules: readonly AclEntry[];
  readonly onChange: (owner: Principal | undefined, rules: readonly AclEntry[]) => void;
}

/** Edit canonical entries only when the actual server copy grants administration. */
export function AclEditor({ bits, owner, rules, onChange }: AclEditorProps) {
  const [group, setGroup] = useState('');
  const [ownerText, setOwnerText] = useState(owner ?? '');
  const [error, setError] = useState<string>();
  useEffect(() => { setOwnerText(owner ?? ''); }, [owner]);
  if ((bits & A) === 0) return null;

  function toggle(index: number, bit: number): void {
    onChange(owner, rules.map((entry, position) => position !== index ? entry
      : 'grant' in entry ? { subject: entry.subject, grant: entry.grant ^ bit }
      : { subject: entry.subject, deny: entry.deny ^ bit }));
  }

  function add(ownerSubject = false): void {
    const name = group.trim();
    if (!ownerSubject && name.length === 0) return;
    onChange(owner, [...rules, { subject: ownerSubject ? { owner: true } : { group: name }, grant: R }]);
    setGroup('');
  }

  /** Validate the user's principal input with the existing canonical node boundary. */
  function editOwner(value: string): void {
    const input = { $path: '/', $type: 'dir', ...(value.length === 0 ? {} : { $owner: value }) };
    if (!isNodeInput(input)) { setError('Invalid owner principal'); return; }
    setError(undefined);
    onChange(input.$owner, rules);
  }

  return <section aria-label="Access control" className="space-y-2 border-t border-border py-3">
    <h3 className="text-sm font-semibold">Access control · {BITS.map(({ bit, label }) => bits & bit ? label : '').join('')}</h3>
    <label className="block text-xs">Owner<Input aria-label="Owner" value={ownerText}
      onChange={event => setOwnerText(event.target.value)} onBlur={() => editOwner(ownerText)} /></label>
    {error !== undefined && <p role="alert">{error}</p>}
    {rules.map((entry, index) => <div key={index} className="flex items-center gap-2 text-xs">
      <span>{'group' in entry.subject ? entry.subject.group : 'Owner'}</span>
      <select aria-label={`Rule ${index + 1} mode`} value={'grant' in entry ? 'grant' : 'deny'}
        onChange={event => onChange(owner, rules.map((rule, position) => position !== index ? rule
          : event.target.value === 'grant' ? { subject: rule.subject, grant: 'grant' in rule ? rule.grant : rule.deny }
          : { subject: rule.subject, deny: 'grant' in rule ? rule.grant : rule.deny }))}>
        <option value="grant">Grant</option><option value="deny">Deny</option>
      </select>
      {BITS.map(({ bit, label }) => <Button key={label} size="sm" variant="outline"
        aria-label={`Rule ${index + 1} ${label}`} aria-pressed={Boolean(('grant' in entry ? entry.grant : entry.deny) & bit)}
        onClick={() => toggle(index, bit)}>{label}</Button>)}
      <Button variant="ghost" onClick={() => onChange(owner, rules.filter((_, position) => position !== index))}>Remove rule</Button>
    </div>)}
    <div className="flex gap-2"><Input aria-label="Group" placeholder="Group" value={group} onChange={event => setGroup(event.target.value)} />
      <Button onClick={() => add()}>Add group</Button><Button onClick={() => add(true)}>Add owner</Button></div>
  </section>;
}
