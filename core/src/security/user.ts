import { registerType } from '#comp';
import { loadSchemasFromDir } from '#schema/load';

/** Account lifecycle state for auth and access decisions. */
class User {
  /** @title Status */
  status: 'active' | 'pending' | 'blocked' = 'pending';
}
registerType('user', User);

/** Password hash storage for local credential authentication. */
class Credentials {
  /** @title Password hash */
  hash: string = '';
}
registerType('credentials', Credentials);
loadSchemasFromDir(new URL('./schemas', import.meta.url).pathname);
