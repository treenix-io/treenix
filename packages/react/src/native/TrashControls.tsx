import { useState } from 'react';
import { W, type Row, type ViewOwner } from '@treenx/core/kernel/types';
import { componentEntries } from '@treenx/core/kernel/migrate';
import { useNativeNode } from '#tree/native-hooks';
import { useNativeSource } from '#tree/native-source-context';

/** Authorize presentation against the actual declaration; the action rechecks caller rights. */
export function NativeTrashControls({ owner, rows }: { owner: ViewOwner; rows: readonly Row[] }) {
  const source = useNativeSource();
  const declaration = useNativeNode(owner.path);
  const copy = declaration.members[0];
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<string>();

  if (declaration.phase !== 'ready' || copy === undefined || !('node' in copy)) return null;

  const component = componentEntries(copy.node).find(([name]) => name === owner.component)?.[1];
  if (component?.$type !== 't.mount.trash' || (copy.bits & W) === 0) return null;

  /** Drain streamed commits while waiting for the canonical accepted outcome. */
  async function execute(action: 'restore' | 'undo', args: unknown): Promise<void> {
    setBusy(true);
    setError('');
    setProgress(action === 'restore' ? 'Восстановление…' : 'Отмена выбранных удалений…');

    try {
      const pending = source.act({ path: owner.path, component: owner.component, action, args });
      await Promise.all([
        pending.outcome,
        (async () => {
          for await (const chunk of pending.chunks) void chunk;
        })(),
      ]);
      setSelected(new Set());
      setProgress(action === 'restore' ? 'Восстановлено' : 'Выбранные удаления отменены');
    } catch (error) {
      setProgress(undefined);
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const chosen = rows.filter((row) => selected.has(row.key));

  return (
    <section aria-label="Восстановление из корзины" className="flex flex-col gap-3">
      {rows.map((row) => (
        <div key={row.key} className="flex items-center gap-2">
          <input
            type="checkbox"
            aria-label={`Выбрать ${row.key}`}
            checked={selected.has(row.key)}
            disabled={busy}
            onChange={(event) =>
              setSelected((current) => {
                const next = new Set(current);
                if (event.target.checked) next.add(row.key);
                else next.delete(row.key);
                return next;
              })
            }
          />
          <pre className="min-w-0 flex-1 overflow-auto text-sm">{JSON.stringify(row.path)}</pre>
          <button
            disabled={busy}
            className="rounded bg-slate-900 px-3 py-2 text-white disabled:opacity-40"
            onClick={() => {
              void execute('restore', row.address);
            }}
          >
            Восстановить
          </button>
        </div>
      ))}
      <button
        disabled={busy || chosen.length === 0}
        className="rounded bg-slate-900 px-3 py-2 text-white disabled:opacity-40"
        onClick={() => {
          void execute(
            'undo',
            chosen.map((row) => row.address),
          );
        }}
      >
        Отменить выбранные удаления
      </button>
      {progress !== undefined && <p role="status">{progress}</p>}
      {error !== '' && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
