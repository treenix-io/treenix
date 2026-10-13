import { declareClientType } from '#comp/client-declaration';
import type { Entry } from './entries-alpha';
import { Mode } from './entries-beta';

class ImportCollisionAlpha {
  entries: Entry[] = [];
  // Cross-file enum used as both the type annotation AND default value —
  // exercises lookupType() and resolveEnum() following the same import.
  mode: Mode = Mode.Fast;
}

declareClientType('test.import-collision-alpha', ImportCollisionAlpha);
