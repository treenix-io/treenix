import { registerType } from '#comp';
import { R, register, W } from '#core';
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

// Only admins can modify groups; owner can read own groups
register('groups', 'acl', () => [
  { g: 'admins', p: R | W },
  { g: 'owner', p: R },
]);
loadSchemasFromDir(new URL('./schemas', import.meta.url).pathname);
