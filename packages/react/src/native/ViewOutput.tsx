import { useState } from 'react'
import type { LaneMember } from '@treenx/core/client/twp'
import type { NativeSnapshot } from '#tree/native-source'

/** Retain selection by real identity while displaying the owning subscription's current payload. */
function identity(member: LaneMember): string {
  return member.kind === 'computed'
    ? member.node.$id
    : 'node' in member.copy
      ? member.copy.node.$id
      : member.copy.id
}

/** Schema errors remain visible without treating them as a readable node payload. */
function ViewMemberDetails({ member }: { member: LaneMember }) {
  let content: string
  if (member.kind === 'computed') content = JSON.stringify(member.node, null, 2)
  else {
    const copy = member.copy
    if ('error' in copy) return <p role="alert">{copy.path}: {copy.error.code}</p>
    content = JSON.stringify(copy.node, null, 2)
  }

  return <pre aria-label="Данные View" className="overflow-auto rounded bg-slate-100 p-3 text-sm">{content}</pre>
}

/** Inspect declassified View output without creating a path subscription or mutation controls. */
export function NativeViewOutput({ snapshot, title }: { snapshot: NativeSnapshot; title?: string }) {
  const [selectedId, select] = useState<string>()
  const selected = selectedId === undefined
    ? snapshot.output?.[0]
    : snapshot.output?.find(member => identity(member) === selectedId)

  return <section aria-label="Результат View" className="flex min-w-0 flex-1 flex-col gap-3">
    <h2 className="text-xl font-semibold">{title ?? 'View'}</h2>
    <p className="text-sm text-slate-600">Только чтение</p>
    {snapshot.output?.map(member => {
      const path = member.kind === 'computed'
        ? member.node.$path
        : 'node' in member.copy
          ? member.copy.node.$path
          : member.copy.path
      return <button key={identity(member)} className="text-left underline" onClick={() => select(identity(member))}>{path}{
        member.kind === 'copy' && 'error' in member.copy ? `: ${member.copy.error.code}` : ''
      }</button>
    })}
    {selected !== undefined && <ViewMemberDetails member={selected} />}
    {snapshot.rows !== undefined && <div aria-label="Строки View" className="flex flex-col gap-2">
      {snapshot.rows.map((row, index) => <pre key={index} className="overflow-auto rounded bg-slate-100 p-3 text-sm">{JSON.stringify(row, null, 2)}</pre>)}
    </div>}
  </section>
}
