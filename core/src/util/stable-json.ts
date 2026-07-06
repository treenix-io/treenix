// Deterministic JSON — object keys sorted at every level, so logically equal
// values stringify identically regardless of construction order. Used for
// identity keys (query watch matchKey, read-plan hash), NOT for wire payloads.

export function stableJson(value: unknown): string {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
    .join(',')}}`;
}
