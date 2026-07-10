import { installActionContextRuntime, type ExecCtx } from '#comp/context';
import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage<ExecCtx>();

installActionContextRuntime({
  get: () => storage.getStore(),
  run: (ctx, action) => storage.run(ctx, action),
});
