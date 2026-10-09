import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { openTwpHttp } from '@treenx/core/client/http-twp'
import { createTwpClient, type TwpClient } from '@treenx/core/client/twp'
import { KernelError } from '@treenx/core/errors'
import { A, R, W, type Credential } from '@treenx/core/kernel/types'
import { isNodeInput, isSelector } from '@treenx/core/protocol/twp'
import { createNativeTreeSource } from '#tree/native-source'
import { NativeSourceProvider, useNativeSource } from '#tree/native-source-context'
import { useNativeChildren, useNativeNode } from '#tree/native-hooks'

/** Render transport and application failures as user-facing text. */
const message = (error: unknown) =>
  error instanceof KernelError
    ? `${error.code}: ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);
const inputClass = 'w-full rounded border border-slate-300 bg-white px-3 py-2 text-slate-900';
const buttonClass = 'rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-40';

/** Edit a node snapshot and invoke actions allowed by its current rights. */
function NodeEditor({ path }: { path: string }) {
  const source = useNativeSource(),
    snapshot = useNativeNode(path),
    copy = snapshot.members[0];
  const [draft, setDraft] = useState(''),
    [dirty, setDirty] = useState(false);
  const [baseRev, setBaseRev] = useState<string>();
  const [response, setResponse] = useState<string>();
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [action, setAction] = useState(''),
    [args, setArgs] = useState('{}');
  useEffect(() => {
    setDirty(false);
    setError('');
  }, [source, path]);
  useEffect(() => {
    if (!dirty && copy !== undefined && 'node' in copy) {
      const { $id, $rev, ...input } = copy.node;
      setDraft(JSON.stringify(input, null, 2));
      setBaseRev($rev);
    }
  }, [copy, dirty]);
  /** Save the edited node against the revision that was loaded. */
  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (copy === undefined || !('node' in copy)) return;
    setBusy(true);
    setError('');
    try {
      const node: unknown = JSON.parse(draft);
      if (!isNodeInput(node) || node.$path !== path)
        throw new KernelError('INVALID', 'Сохраните адрес и укажите корректный узел');
      if (baseRev === undefined)
        throw new KernelError('INVALID', 'Версия редактируемого узла отсутствует');
      await source.commit({
        changes: [{ op: 'put', node }],
        expect: { nodes: [{ path, rev: baseRev }] },
      }).outcome;
      setDirty(false);
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  /** Run the selected action with JSON arguments. */
  async function execute(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError('');
    setResponse(undefined);
    try {
      const data: unknown = JSON.parse(args);
      const pending = source.act({ path, action, args: data });
      const [outcome] = await Promise.all([
        pending.outcome,
        (async () => {
          // Keeping only the latest piece displays progress without retaining the stream.
          for await (const piece of pending.chunks) setResponse(JSON.stringify(piece, null, 2));
        })(),
      ]);
      if (outcome.value !== undefined) setResponse(JSON.stringify(outcome.value, null, 2));
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="flex min-w-0 flex-1 flex-col gap-4">
      <h2 className="text-xl font-semibold">{path}</h2>
      {response !== undefined && (
        <pre aria-label="Ответ действия" className="overflow-auto rounded bg-slate-100 p-3 text-sm">
          {response}
        </pre>
      )}
      {error && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}
      {snapshot.error !== undefined && (
        <p role="alert" className="text-red-700">
          {message(snapshot.error)}
        </p>
      )}
      {snapshot.phase === 'ready' && copy === undefined && <p role="status">Узел отсутствует</p>}
      {copy !== undefined &&
        ('error' in copy ? (
          <p role="alert">
            {copy.error.code}: {copy.error.message}
          </p>
        ) : (
          <>
            <p className="text-sm text-slate-600">
              {copy.node.$type} ·{' '}
              {(copy.bits & A) !== 0
                ? 'Администратор'
                : (copy.bits & W) !== 0
                  ? 'Редактирование'
                  : 'Просмотр'}
            </p>
            <pre
              aria-label="Текущее состояние"
              className="overflow-auto rounded bg-slate-100 p-3 text-sm"
            >
              {JSON.stringify(copy.node, null, 2)}
            </pre>
            {(copy.bits & W) !== 0 && (
                <form onSubmit={save} className="flex flex-col gap-3">
                  <label htmlFor="node-json">Данные узла</label>
                  <textarea
                    id="node-json"
                    disabled={busy}
                    className={`${inputClass} min-h-56 font-mono text-sm`}
                    value={draft}
                    onChange={(event) => {
                      if (!dirty) setBaseRev(copy.node.$rev);
                      setDraft(event.target.value);
                      setDirty(true);
                    }}
                  />
                  <button className={buttonClass} disabled={busy || !dirty}>
                    Сохранить
                  </button>
                </form>
            )}
            {(copy.bits & R) !== 0 && (
                <form
                  onSubmit={execute}
                  className="flex flex-col gap-3 border-t border-slate-200 pt-4"
                >
                  <label htmlFor="action-name">Действие</label>
                  <input
                    id="action-name"
                    className={inputClass}
                    value={action}
                    onChange={(event) => setAction(event.target.value)}
                  />
                  <label htmlFor="action-args">Аргументы JSON</label>
                  <textarea
                    id="action-args"
                    className={`${inputClass} font-mono text-sm`}
                    value={args}
                    onChange={(event) => setArgs(event.target.value)}
                  />
                  <button className={buttonClass} disabled={busy || !action}>
                    Выполнить
                  </button>
                </form>
            )}
          </>
        ))}
    </section>
  );
}

/** Browse child nodes and select one for editing. */
export function NativeTreeBrowser() {
  const [parent, setParent] = useState('/'),
    [path, setPath] = useState('/');
  const [pathDraft, setPathDraft] = useState('/'),
    [pathError, setPathError] = useState('');
  const children = useNativeChildren(parent);
  /** Open the entered address as both the child listing and selected node. */
  function open(event: FormEvent): void {
    event.preventDefault();
    setPathError('');
    try {
      if (!isSelector({ node: pathDraft }))
        throw new KernelError('INVALID', 'Укажите корректный адрес узла');
      setParent(pathDraft);
      setPath(pathDraft);
    } catch (error) {
      setPathError(message(error));
    }
  }
  return (
    <div className="flex gap-8">
      <aside className="flex w-64 shrink-0 flex-col gap-3">
        <form onSubmit={open} className="flex flex-col gap-3">
          <label htmlFor="tree-path">Адрес</label>
          <input
            id="tree-path"
            className={inputClass}
            value={pathDraft}
            onChange={(event) => setPathDraft(event.target.value)}
          />
          <button className={buttonClass}>Открыть</button>
        </form>
        {pathError && (
          <p role="alert" className="text-red-700">
            {pathError}
          </p>
        )}
        {children.error !== undefined && (
          <p role="alert" className="text-red-700">
            {message(children.error)}
          </p>
        )}
        {children.members.map((copy) =>
          'node' in copy ? (
            <div key={copy.node.$id} className="flex gap-2">
              <button
                className="min-w-0 flex-1 truncate text-left underline"
                onClick={() => setPath(copy.node.$path)}
              >
                {copy.node.$path}
              </button>
              <button
                aria-label={`Дети ${copy.node.$path}`}
                onClick={() => {
                  setPathDraft(copy.node.$path);
                  setParent(copy.node.$path);
                  setPathError('');
                }}
              >
                →
              </button>
            </div>
          ) : (
            <p key={copy.id} role="alert">
              {copy.path}: {copy.error.code}
            </p>
          ),
        )}
        {children.next !== undefined && (
          <button
            className={buttonClass}
            disabled={children.phase !== 'ready'}
            onClick={children.loadMore}
          >
            Загрузить ещё
          </button>
        )}
      </aside>
      <NodeEditor key={path} path={path} />
    </div>
  );
}

/** Own a native source for the lifetime of its connected client. */
function ConnectedBrowser({ client }: { client: TwpClient }) {
  const source = useMemo(() => createNativeTreeSource(client), [client]);
  useEffect(() => () => source.close(), [source]);
  return (
    <NativeSourceProvider source={source}>
      <NativeTreeBrowser />
    </NativeSourceProvider>
  );
}

/** Log in, establish the native client, and render the connected browser. */
export function NativeEditor() {
  const [client, setClient] = useState<TwpClient>(),
    [account, setAccount] = useState('/admin'),
    [password, setPassword] = useState('');
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => () => client?.close(), [client]);
  /** Replace the active client only after login and transport setup succeed. */
  async function connect(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError('');
    let next: TwpClient | undefined;
    try {
      const response = await fetch('/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account, password }),
      });
      if (!response.ok) throw new Error(`Вход отклонён (${response.status})`);
      const credential: Credential = await response.json();
      const connection = await openTwpHttp({ url: location.origin, credential });
      next = createTwpClient(connection, {
        close: connection.close,
        onError: (error) => {
          setError(message(error));
          setClient(undefined);
        },
      });
      await next.ready;
      setPassword('');
      setClient(next);
    } catch (error) {
      next?.close();
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="min-h-screen bg-white p-8 text-slate-900">
      <header className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Treenix</h1>
      </header>
      {error && (
        <p role="alert" className="mb-4 text-red-700">
          {error}
        </p>
      )}
      {client === undefined ? (
        <form onSubmit={connect} className="mx-auto flex max-w-sm flex-col gap-4">
          <label htmlFor="account">Учётная запись</label>
          <input
            id="account"
            autoComplete="username"
            className={inputClass}
            value={account}
            onChange={(event) => setAccount(event.target.value)}
          />
          <label htmlFor="password">Пароль</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            className={inputClass}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <button className={buttonClass} disabled={busy || !account || !password}>
            Войти
          </button>
        </form>
      ) : (
        <ConnectedBrowser client={client} />
      )}
    </main>
  );
}
