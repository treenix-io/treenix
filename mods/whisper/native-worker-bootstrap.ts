import { tsImport } from 'tsx/esm/api';

await tsImport('./native-worker.ts', import.meta.url);
