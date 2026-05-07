// R5-BRAHMAN-1: QuickJS sandbox for expression evaluation in brahman action types.
// Replaces `new Function(...)` calls — no host globals (`process`, `require`, `fetch`),
// bounded memory, bounded stack, hard deadline. Mirrors the `loadDynamicAction` pattern
// already used in `engine/core/src/server/actions.ts`.
//
// Use for value/boolean expressions only. The full-power `EvalAction` (which needs
// `ctx`/`tree` host access) is NOT moved here — it should be restricted via type-ACL
// on the action node so only admins can plant code, since sandboxing it would
// destroy the feature.

import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten';

const EVAL_TIMEOUT_MS = 50;
const EVAL_MEMORY_BYTES = 1 * 1024 * 1024; // 1 MB
const EVAL_STACK_BYTES = 128 * 1024;

/** Evaluate a JavaScript expression in a QuickJS sandbox.
 *  Returns the expression's value (JSON-cloneable), or throws if it fails / times out.
 *  Variables are JSON-serialized into the sandbox — functions/promises/host references
 *  cannot leak in. */
export async function evalExpr(expr: string, vars: Record<string, unknown> = {}): Promise<unknown> {
  if (typeof expr !== 'string' || expr.trim().length === 0)
    throw new Error('brahman eval: empty expression');
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(EVAL_MEMORY_BYTES);
  runtime.setMaxStackSize(EVAL_STACK_BYTES);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + EVAL_TIMEOUT_MS));
  const vm = runtime.newContext();
  try {
    for (const [k, v] of Object.entries(vars)) {
      let json: string;
      try { json = JSON.stringify(v ?? null); } catch { json = 'null'; }
      const handle = vm.evalCode(`(${json})`);
      if ('value' in handle) { vm.setProp(vm.global, k, handle.value); handle.value.dispose(); }
    }
    // Wrap as IIFE so the expression itself can use commas, sequence ops, etc.
    const wrapped = `(function() { return (${expr}) })()`;
    const result = vm.evalCode(wrapped);
    if (result.error) {
      const err = vm.dump(result.error);
      result.error.dispose();
      throw new Error(
        `brahman eval failed: ${typeof err === 'object' && err ? (err as { message?: string }).message ?? JSON.stringify(err) : String(err)}`,
      );
    }
    const value = vm.dump(result.value);
    result.value.dispose();
    return value;
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}

/** Coerce eval result to boolean. Used for IfElse/Tag conditions. */
export async function evalBool(expr: string, vars: Record<string, unknown>): Promise<boolean> {
  try { return !!(await evalExpr(expr, vars)); }
  catch { return false; }
}
