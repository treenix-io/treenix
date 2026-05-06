import { registerType } from '#comp';

export class RefTarget {
  name = '';
}

registerType('test.ref-target-beta', RefTarget);
