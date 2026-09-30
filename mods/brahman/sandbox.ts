// R5-BRAHMAN-1: QuickJS sandbox for expression evaluation in brahman action types.
// Replaces `new Function(...)` calls — no host globals (`process`, `require`, `fetch`),
// bounded memory, bounded stack, hard deadline. Mirrors the `loadDynamicAction` pattern
// already used in `engine/core/src/server/actions.ts`.
//
// Use for value/boolean expressions only. The full-power `EvalAction` (which needs
// `ctx`/`tree` host access) is NOT moved here — it should be restricted via type-ACL
// on the action node so only admins can plant code, since sandboxing it would
// destroy the feature.

import { getQuickJS } from 'quickjs-emscripten';

const EVAL_CPU_MS = 50;
const EVAL_MEMORY_BYTES = 1 * 1024 * 1024; // 1 MB
const EVAL_STACK_BYTES = 128 * 1024;

// The deadline counts thread CPU; without it every eval would fail at its first interrupt poll.
if (typeof process.threadCpuUsage !== 'function')
  throw new Error(`brahman sandbox needs process.threadCpuUsage (Node 23.9+); this is Node ${process.version}`);

function threadCpuMs(): number {
  const { user, system } = process.threadCpuUsage();
  return (user + system) / 1000;
}

/**
 * Interrupt handler: true once this thread has spent `budgetMs` of CPU since its first call. QuickJS first polls
 * it at the first function call, after parsing, so the lazy WASM compile of the parser and interpreter — paid by
 * the first eval in a process — is not charged to the expression, nor is time the process spends descheduled
 * under load; a wall-clock deadline charged both and failed trivial expressions. The expression's own work keeps
 * the same bound.
 */
export function cpuDeadline(budgetMs: number): () => boolean {
  let deadline: number | undefined;
  return () => {
    const now = threadCpuMs();
    deadline ??= now + budgetMs;
    return now > deadline;
  };
}

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
  const vm = runtime.newContext();
  try {
    for (const [k, v] of Object.entries(vars)) {
      // Host data only: a non-serializable var is a caller bug — fail loud.
      const value = vm.unwrapResult(vm.evalCode(`(${JSON.stringify(v ?? null)})`));
      vm.setProp(vm.global, k, value);
      value.dispose();
    }
    // Deadline covers the expression only: armed before context creation and
    // var injection, the 50ms budget was eaten by setup under CPU load.
    runtime.setInterruptHandler(cpuDeadline(EVAL_CPU_MS));
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

/** Coerce eval result to boolean. Used for IfElse/Tag conditions; a failing condition fails the action. */
export async function evalBool(expr: string, vars: Record<string, unknown>): Promise<boolean> {
  return !!(await evalExpr(expr, vars));
}
