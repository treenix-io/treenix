import { isChildPath } from '#core/path';
import type { AuthAdmission } from '#kernel/auth-factory';
import { credentialScope } from '#kernel/auth/crypto';
import type { Path } from '#kernel/types';
import { stableJson } from '#util/stable-json';

/** Intersects subtree masks; a nested call can only remove admitted authority. */
export function intersectActionScope(
  inherited: readonly Path[] | undefined,
  requested: readonly Path[] | undefined,
): readonly Path[] | undefined {
  const paths = credentialScope(requested);
  if (paths === undefined) return inherited;
  if (inherited === undefined) return paths;

  const intersection: Path[] = [];
  for (const parent of inherited)
    for (const child of paths) {
      if (parent === child || isChildPath(parent, child, false)) intersection.push(child);
      else if (isChildPath(child, parent, false)) intersection.push(parent);
    }

  return Object.freeze([...new Set(intersection)].sort());
}

/** Keeps the real identity, revocation and dependencies while narrowing its request rights. */
export function scopedActionAdmission(
  admission: AuthAdmission,
  scope: readonly Path[] | undefined,
  writeScope: readonly Path[] | undefined,
): AuthAdmission {
  if (scope === undefined && writeScope === undefined) return admission;
  const mask = intersectActionScope(admission.actor.scope, scope);
  const writes = intersectActionScope(admission.actor.writeScope, writeScope);
  const actor = Object.freeze({ ...admission.actor, scope: mask, writeScope: writes });

  return Object.freeze({
    ...admission,
    actor,
    resolution: Object.freeze({ ...admission.resolution, actor }),
    dependencyKey: `${admission.dependencyKey}:scope:${stableJson([mask, writes])}`,
    dependency: () => Object.freeze({ ...admission.dependency(), actor }),
  });
}
