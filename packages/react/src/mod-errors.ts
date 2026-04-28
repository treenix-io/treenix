// Mod load error tracking — shared between barrel, vite plugin virtual module, and App UI

const errors: Map<string, string> = ((globalThis as Record<string, unknown>).__treenixModErrors ??= new Map()) as Map<string, string>;

/** Dynamic import wrapper — catches failures and records them */
export function loadMod(name: string, load: () => Promise<unknown>): Promise<unknown> {
  return load().catch((e: Error) => {
    errors.set(name, e.message);
    console.warn(`[treenix] mod ${name} skipped:`, e.message);
  });
}

/** Mods that failed to load: name → error message */
export function getModErrors(): Map<string, string> { return errors; }
