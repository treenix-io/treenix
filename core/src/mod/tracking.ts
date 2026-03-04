// Type→Mod tracking — runtime map of which mod registered which types
// setCurrentMod() wraps import() in loader; trackType() called from registerType.
// Convention fallback: first segment of type name = mod name (cafe.contact → cafe).

let currentMod: string | null = null;

// type → mod name
const typeToMod = new Map<string, string>();

// Aliases for types whose first segment ≠ mod dir name
const MOD_ALIASES: Record<string, string> = {
  order: 'orders',
  pult: 'pult',
};

export function setCurrentMod(name: string | null): void {
  currentMod = name;
}

export function getCurrentMod(): string | null {
  return currentMod;
}

export function trackType(typeName: string): void {
  if (currentMod) {
    typeToMod.set(typeName, currentMod);
  }
}

export function getTypesForMod(modName: string): string[] {
  const types: string[] = [];
  for (const [type, mod] of typeToMod) {
    if (mod === modName) types.push(type);
  }
  return types;
}

/** Infer mod name from type name: tracked → exact; else first segment + alias lookup */
export function inferModFromType(typeName: string): string {
  const tracked = typeToMod.get(typeName);
  if (tracked) return tracked;

  const first = typeName.split('.')[0];
  return MOD_ALIASES[first] ?? first;
}

// For tests
export function clearTracking(): void {
  typeToMod.clear();
  currentMod = null;
}
