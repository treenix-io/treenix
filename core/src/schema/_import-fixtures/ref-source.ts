import { declareClientType } from '#comp/client-declaration';
import { RefTarget as AlphaRefTarget } from './ref-target-alpha';
import { RefTarget as BetaRefTarget } from './ref-target-beta';

class RefSource {
  alpha?: AlphaRefTarget;
  beta?: BetaRefTarget;
}

declareClientType('test.ref-source', RefSource);
