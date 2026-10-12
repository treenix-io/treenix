import { agentSeed } from '#agent/seed-data';
import { nativeOfficeSeed } from '#agent/native-office-seed';

/** Declare the existing Agent office through its shared native infrastructure owner. */
export function nativeAgentSeed() {
  return nativeOfficeSeed(
    'agent',
    agentSeed,
    {
      orgPath: '/org',
      workspaceBase: '/board',
      readScope: ['/board', '/memory', '/org', '/sys/types', '/sys/mods'],
    },
    ['/agents/qa'],
  );
}
