import type { NativeModuleDeployment } from '#kernel/manifest';

/** Pairing actions and account permissions are installed by the authentication bootstrap owner. */
export default function agentPortModule(): NativeModuleDeployment {
  return { manifest: { id: '@treenx/core/agent-port', types: [], security: [], open: [] } };
}
