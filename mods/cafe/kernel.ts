import { CafeContact } from '#cafe/types';
import { registerKernelSeeds } from '@treenx/core/kernel';
import { nativeSeed } from '#prefab/seed';
import { cafeSeed } from '#cafe/seed-data';

registerKernelSeeds(
  nativeSeed(
    'cafe',
    cafeSeed.map((node) =>
      node.$type === 'cafe.contact' ? { ...new CafeContact(), ...node } : node,
    ),
  ),
);
