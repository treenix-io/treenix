import { registerType } from '#comp';
import { R, register, W } from '#core';
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

// The owner holds R|W on their user node; without a type rule a stolen session
// read the scrypt hash (offline crack) and rewrote it (permanent takeover).
// Login and registration run as the system identity.
register('credentials', 'acl', () => [
  { g: 'system', p: R | W },
  { g: 'admins', p: R | W },
]);

loadSchemasFromDir(new URL('./schemas', import.meta.url).pathname);
