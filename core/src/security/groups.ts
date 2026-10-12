import { registerType } from '#comp';
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
loadSchemasFromDir(new URL('./schemas', import.meta.url).pathname);
