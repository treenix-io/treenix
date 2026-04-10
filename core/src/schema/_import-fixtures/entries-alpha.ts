// Fixture for cross-file import resolution — alpha source.
// Deliberately declares `Entry` with the same name as entries-beta.ts
// but a different shape, to exercise name-collision handling.
export type Entry = { kind: 'alpha'; count: number };
