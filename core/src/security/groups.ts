import { registerType } from '#comp';
import { type GroupPerm, R, register, W } from '#core';
import { loadSchemasFromDir } from '#schema/load';

/** User group memberships — ACL group list for access control */
class Groups {
  /**
   * @title Groups
   * @format tags
   * @description User group memberships
   */
  list: string[] = [];
}
registerType('groups', Groups);

// admins manage groups; owner reads own; system (kernel) reads+writes during
// claim-building (buildClaims) and user provisioning (register/devLogin) — granted
// like any other group, never via an ACL-engine bypass.
export const GROUPS_ACL: GroupPerm[] = [
  { g: 'admins', p: R | W },
  { g: 'system', p: R | W },
  { g: 'owner', p: R },
];
register('groups', 'acl', () => GROUPS_ACL);
loadSchemasFromDir(new URL('./schemas', import.meta.url).pathname);
