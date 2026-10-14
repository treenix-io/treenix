/**
 * Simple glob matching for tool/resource names.
 * Only `*` wildcard is supported (matches any sequence of characters).
 */

/** Test if `value` matches a single glob `pattern` (only `*` wildcard supported). */
export function globMatch(pattern: string, value: string): boolean {
  if (pattern === value) return true;
  if (!pattern.includes('*')) return false;
  const re = new RegExp(
    '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
  );
  return re.test(value);
}

/** Test if `value` matches any of the glob `patterns`. */
export function matchesAny(patterns: string[], value: string): boolean {
  return patterns.some((p) => globMatch(p, value));
}
