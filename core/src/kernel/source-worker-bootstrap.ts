import { tsImport } from 'tsx/esm/api';

await tsImport('./source-worker.ts', import.meta.url);
