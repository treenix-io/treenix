// Deterministic JSON — object keys sorted at every level, so logically equal
// values stringify identically regardless of construction order. Used for
// identity keys (query watch matchKey, read-plan hash), NOT for wire payloads.
// Keys sort by UTF-16 code unit: a locale collation varies with the process's
// ICU data and ranks distinct keys equal (U+00E9 and e + U+0301), which left
// their order, and the identity, to construction order.

export function stableJson(value: unknown): string {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(record[k])}`)
    .join(',')}}`;
}
