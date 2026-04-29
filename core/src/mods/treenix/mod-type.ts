// t.mod — type node for mod catalog entries
import { registerType } from '@treenx/core/comp';

/** Mod catalog entry */
class Mod {
  name = '';
  state: 'discovered' | 'loading' | 'loaded' | 'failed' | 'disabled' = 'loaded';
}

registerType('t.mod', Mod);
