import { nativeIdealManifest } from './native';
import type { NativeModuleDeployment } from '@treenx/core/kernel/manifest';
import { R, W } from '@treenx/core/kernel';
import { nativeSeed } from '#prefab/seed';
import { idealSeed } from './seed-data';

export default function createNativeIdeal(): NativeModuleDeployment {
  return {
    manifest: nativeIdealManifest(),
    seeds: nativeSeed(
      'ideal',
      [...idealSeed, { $path: '/sys/autostart/ideal', $type: 'ref', $ref: '/ideal' }],
      [{ $path: '/sys/autostart', $type: 't.autostart' }],
      [
        { executor: 'ideal', target: 'ideal', grant: R | W },
        { executor: '/sys/autostart', target: '/sys/autostart', grant: R },
        { executor: '/sys/autostart', target: 'ideal', grant: R },
      ],
    ),
  };
}
