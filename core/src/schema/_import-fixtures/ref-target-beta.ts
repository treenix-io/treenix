import { declareClientType } from '#comp/client-declaration';

export class RefTarget {
  name = '';
}

declareClientType('test.ref-target-beta', RefTarget);
