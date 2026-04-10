// Fixture for cross-file import resolution — beta source.
// Same `Entry` name as entries-alpha.ts, intentionally different shape.
export type Entry = { label: string; active: boolean };

// Exported enum used by widget-alpha.ts to exercise cross-file enum resolution
// for both TSTypeReference (the `mode: Mode` annotation) and evalInit's
// Enum.Member default lookup (`Mode.Fast`).
export enum Mode {
  Normal,
  Fast,
  Slow,
}
