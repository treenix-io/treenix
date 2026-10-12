import { registerNativeIdeal } from './native';
import { R, W, registerKernelSeeds } from '@treenx/core/kernel';
import { nativeSeed } from '@treenx/core/mod/native-prefab';
import { idealSeed } from './seed-data';

registerNativeIdeal();
registerKernelSeeds(nativeSeed('ideal', [
  ...idealSeed,
  { $path: '/sys/autostart/ideal', $type: 'ref', $ref: '/ideal' },
], [{ $path: '/sys/autostart', $type: 't.autostart' }], [
  { executor: 'ideal', target: 'ideal', grant: R | W },
  { executor: '/sys/autostart', target: '/sys/autostart', grant: R },
  { executor: '/sys/autostart', target: 'ideal', grant: R },
]));
