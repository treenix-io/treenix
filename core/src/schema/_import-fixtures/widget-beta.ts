import { declareClientType } from '#comp/client-declaration';
import type { Entry } from './entries-beta';

class ImportCollisionBeta {
  entries: Entry[] = [];
}

declareClientType('test.import-collision-beta', ImportCollisionBeta);
