import { createNativeGuardian } from '#agent/native-guardian';
import type { NativeModuleDeployment } from '@treenx/core/kernel/manifest';
import { nativeAgentTypes } from '#agent/native-manifest';
import { createAgentIo } from '#agent/native-io';
import type { AgentProvider } from '#agent/native-io';
import { nativeWorkerType } from '#agent/native-worker';
import { nativePoolType } from '#agent/native-pool-manifest';
import { nativePoolService } from '#agent/native-pool-service';
import { nativeAgentSeed } from '#agent/native-seed';

/** Publishes native agent actions with Guardian approval ownership and its fail-closed gate. */
export function createNativeAgent(provider?: AgentProvider): NativeModuleDeployment {
  const guardian = createNativeGuardian('/guardian/approvals', '/guardian/service');
  return {
    manifest: {
      ...guardian.manifest,
      security: [
        ...guardian.manifest.security,
        { type: 'ai.pool-service', context: 'service', handler: nativePoolService },
      ],
      types: [
        ...guardian.manifest.types,
        ...nativeAgentTypes(guardian.manifest.id),
        nativeWorkerType(guardian.manifest.id),
        nativePoolType(guardian.manifest.id),
      ],
    },
    seeds: nativeAgentSeed(),
    gates: [guardian.gate],
    ...(provider === undefined ? {} : { io: createAgentIo(provider) }),
  };
}

/** Publishes the native agent owner; external models are bound explicitly by deployment modules. */
export default function guardianModule(): NativeModuleDeployment {
  return createNativeAgent();
}
