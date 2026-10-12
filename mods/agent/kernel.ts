import { createNativeGuardian } from '#agent/native-guardian';
import type { NativeModuleDeployment } from '@treenx/core/kernel/manifest';
import { nativeAgentTypes } from '#agent/native-manifest';
import { createAgentIo } from '#agent/native-io';
import type { AgentProvider } from '#agent/native-io';
import { nativeWorkerType } from '#agent/native-worker';

/** Publishes native agent actions with Guardian approval ownership and its fail-closed gate. */
export function createNativeAgent(provider?: AgentProvider): NativeModuleDeployment {
  const guardian = createNativeGuardian();
  return {
    manifest: {
      ...guardian.manifest,
      types: [...guardian.manifest.types, ...nativeAgentTypes(guardian.manifest.id), nativeWorkerType(guardian.manifest.id)],
    },
    gates: [guardian.gate],
    ...(provider === undefined ? {} : { io: createAgentIo(provider) }),
  };
}

/** Publishes the native agent owner; external models are bound explicitly by deployment modules. */
export default function guardianModule(): NativeModuleDeployment {
  return createNativeAgent();
}
