import type { NativeModuleDeployment } from '@treenx/core/kernel/manifest';
import { nativeSeed } from '@treenx/core/mod/native-prefab';
import { metatronSeed } from '#metatron/seed-data';
import template from './schemas/metatron.template.json';
import skill from './schemas/metatron.skill.json';

/** Retains compatibility data and the original assistant; Agent owns the native chat and worker actions. */
export default function createNativeMetatron(): NativeModuleDeployment {
  const owner = '@treenx/mods/metatron';
  const nodes = metatronSeed.map((node) =>
    node.$type !== 'ai.agent'
      ? node
      : {
          ...node,
          systemPrompt: `You are Metatron, the AI brain of a Treenix platform instance.
Use the declared native get_node, list_children, execute, put_node, patch_node and remove_node tools.
Your reads and changes use the current caller's permissions. Typed actions commit independently;
direct changes are staged until the next response frame. Be concise, proactive and precise.`,
        },
  );
  return {
    manifest: {
      id: owner,
      security: [],
      open: [],
      types: [
        {
          name: 'metatron.template',
          module: owner,
          security: 'ordinary',
          version: 0,
          schema: template,
          actions: {},
        },
        {
          name: 'metatron.skill',
          module: owner,
          security: 'ordinary',
          version: 0,
          schema: skill,
          actions: {},
        },
      ],
    },
    seeds: nativeSeed('metatron', nodes, [{ $path: '/sys/routes', $type: 't.dir' }]),
  };
}
