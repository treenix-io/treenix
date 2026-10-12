import type { NativeModuleDeployment, NativeModuleHost } from '@treenx/core/kernel/manifest';
import type { MongoClosedBinding } from '#closed-provider';
import { createMongoManifest } from '#native-mount';

declare module '@treenx/core/kernel/manifest' {
  interface NativeModuleHost {
    readonly mongo?: Readonly<Record<string, MongoClosedBinding>>;
  }
}

/** Bind collection declarations to closed connection nodes under the deployment's ownership. */
export default function createNativeMongo(host: NativeModuleHost): NativeModuleDeployment {
  return { manifest: createMongoManifest(host.mongo ?? {}) };
}
