// Reusable embedding utility — lazy pipeline, batch embed
// Model: nomic-embed-text-v1.5 (768 dims, 8K context, Apache 2.0)
// Switched from snowflake-arctic-embed-m-v2.0 — nomic has better retrieval quality
// and faster inference at same dimensionality. Benchmarked 2026-03-01.
// ONNX Runtime: single-threaded (OMP_NUM_THREADS=1) to prevent native mutex crash.
// All calls serialized via JS queue for additional safety.

import type { FeatureExtractionPipeline } from '@huggingface/transformers';

const MODEL = 'nomic-ai/nomic-embed-text-v1.5';
const DIMS = 768;
const BATCH_SIZE = 16;

let loader: Promise<FeatureExtractionPipeline> | null = null;

function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (!loader) {
    // Force single-threaded ONNX — multi-thread causes native mutex crash
    process.env.OMP_NUM_THREADS = '1';
    process.env.ONNX_NUM_THREADS = '1';

    console.log('[embed] loading', MODEL, '...');
    const t0 = Date.now();
    loader = import('@huggingface/transformers').then(async ({ pipeline, env }) => {
      // Disable multi-threading in ONNX WASM backend too
      env.backends.onnx.wasm!.numThreads = 1;
      const model = await (pipeline as any)('feature-extraction', MODEL, { dtype: 'q8' }) as FeatureExtractionPipeline;
      console.log(`[embed] ready in ${Date.now() - t0}ms`);
      return model;
    });
    loader.catch(e => { console.error('[embed] failed:', e.message); loader = null; });
  }
  return loader;
}

// Serialize access to ONNX runtime — concurrent calls cause mutex crash
let queue: Promise<unknown> = Promise.resolve();

/** Embed texts. isQuery=true adds 'search_query: ' prefix (required by nomic-embed). */
export async function embed(texts: string[], isQuery = false): Promise<number[][]> {
  // Queue this call behind any in-flight embedding
  const result = queue.then(async () => {
    const model = await getEmbedder();
    const input = isQuery
      ? texts.map(t => `search_query: ${t}`)
      : texts.map(t => `search_document: ${t}`);

    const results: number[][] = [];
    for (let i = 0; i < input.length; i += BATCH_SIZE) {
      const batch = input.slice(i, i + BATCH_SIZE);
      const output = await model(batch, { normalize: true, pooling: 'mean' });
      const vecs: number[][] = output.tolist();
      results.push(...vecs);
    }

    return results;
  });

  queue = result.catch(() => {}); // keep queue moving even on error
  return result;
}

/** Check if embedder is loaded (non-blocking). */
export function isEmbedderReady(): boolean { return loader !== null; }

/** Preload the model without blocking. */
export function preloadEmbedder(): void { getEmbedder(); }

/** Release the model. Helps avoid ONNX destructor crash on process exit. */
export async function disposeEmbedder(): Promise<void> {
  if (!loader) return;
  try {
    const model = await loader;
    (model as any).dispose?.();
  } catch {}
  loader = null;
  queue = Promise.resolve();
}

export { DIMS, MODEL };
