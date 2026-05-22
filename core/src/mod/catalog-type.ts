// t.mod — type node for mod catalog entries
import { registerType } from '#comp';
import { loadSchemasFromDir } from '#schema/load';

/** Mod catalog entry */
class Mod {
  name = '';
  state: 'discovered' | 'loading' | 'loaded' | 'failed' | 'disabled' = 'loaded';
}

registerType('t.mod', Mod);
loadSchemasFromDir(new URL('./schemas', import.meta.url).pathname);
