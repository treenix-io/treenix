import { CafeMailService, CafeContact } from '#cafe/types';
import { fileURLToPath } from 'node:url';
import { readSchemasFromDir } from '@treenx/core/schema/load';
import { nativeClassModule } from '#native-module';
import type { NativeModuleDeployment } from '@treenx/core/kernel/manifest';
import { nativeSeed } from '#prefab/seed';
import { cafeSeed } from '#cafe/seed-data';

export default function createNativeCafe(): NativeModuleDeployment {
  return {
    manifest: nativeClassModule(
      '@treenx/mods/cafe',
      {
        'cafe.mail': CafeMailService,
        'cafe.contact': CafeContact,
      },
      readSchemasFromDir(fileURLToPath(new URL('./schemas', import.meta.url))),
    ),
    seeds: nativeSeed(
      'cafe',
      cafeSeed.map((node) =>
        node.$type === 'cafe.contact' ? { ...new CafeContact(), ...node } : node,
      ),
    ),
  };
}
