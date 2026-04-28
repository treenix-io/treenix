import { registerType } from '#comp';

class User {
  /** @title Status */
  status: 'active' | 'pending' | 'blocked' = 'pending';
}
registerType('user', User);

class Credentials {
  /** @title Password hash */
  hash: string = '';
}
registerType('credentials', Credentials);
