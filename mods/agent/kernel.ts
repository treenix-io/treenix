import { createNativeGuardian } from '#agent/native-guardian';
import type { NativeModuleDeployment } from '@treenx/core/kernel/manifest';

/** Bind the approval service and its fail-closed predicate to one deployment. */
export default function guardianModule(): NativeModuleDeployment {
  const guardian = createNativeGuardian();
  return { manifest: guardian.manifest, gates: [guardian.gate] };
}
