import { registerType } from '#comp';
import type { Entry } from './entries-beta';

class ImportCollisionBeta {
  entries: Entry[] = [];
}

registerType('test.import-collision-beta', ImportCollisionBeta);
