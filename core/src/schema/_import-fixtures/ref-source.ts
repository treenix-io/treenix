import { registerType } from '#comp';
import { RefTarget as AlphaRefTarget } from './ref-target-alpha';
import { RefTarget as BetaRefTarget } from './ref-target-beta';

class RefSource {
  alpha?: AlphaRefTarget;
  beta?: BetaRefTarget;
}

registerType('test.ref-source', RefSource);
