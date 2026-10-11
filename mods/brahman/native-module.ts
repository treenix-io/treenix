import { readFile } from 'node:fs/promises';
import { buildRegisteredTypeDef } from '@treenx/core/kernel/typedef';
import type { ActionDef, ModuleManifest, ServiceHandler, TypeDef } from '@treenx/core/kernel/types';
import type { TypeSchema } from '@treenx/core/schema/types';
import { telegramActions } from '#brahman/native-action-telegram';
import { stateActions } from '#brahman/native-action-state';
import { flowActions } from '#brahman/native-action-flow';
import { evalAction } from '#brahman/native-action-eval';
import { conversationActions, conversationDataSchema, initializeConversation } from '#brahman/native-action-conversation';
import { userActions } from '#brahman/native-user';

/** Publish the existing authored schemas with their native execution owners. */
export async function nativeBrahmanManifest(
  service: ServiceHandler,
  sourceIo: ModuleManifest['sourceIo'],
): Promise<ModuleManifest> {
  const types: TypeDef[] = [];
  const manifest: ModuleManifest = {
    id: 'treenix.brahman', types, open: [], sourceIo,
    security: [{ type: 'brahman.bot', context: 'service', handler: service }],
  };
  const handlers: Readonly<Record<string, ActionDef>> = {
    ...telegramActions(), ...stateActions(), ...flowActions(), eval: evalAction(manifest),
  };

  for (const suffix of ['bot', 'page', 'user', 'session', 'message',
    ...Object.keys(handlers).map(name => `action.${name}`)]) {
    const name = `brahman.${suffix}`;
    const schema: TypeSchema = JSON.parse(await readFile(new URL(`./schemas/${name}.json`, import.meta.url), 'utf8'));
    let actions: Readonly<Record<string, ActionDef>> = {};
    if (suffix === 'bot') actions = { initialize: initializeConversation(),
      start: { kind: 'write', args: { type: 'object', additionalProperties: false }, async handler(context) { await context.requireAdmin(); context.change.patch(context.node.$path, { $set: { running: true } }); } },
      stop: { kind: 'write', args: { type: 'object', additionalProperties: false }, async handler(context) { await context.requireAdmin(); context.change.patch(context.node.$path, { $set: { running: false } }); } },
    };
    else if (suffix === 'user') actions = userActions();
    else if (suffix === 'session') {
      schema.properties.data = conversationDataSchema;
      actions = conversationActions();
    } else if (suffix.startsWith('action.')) actions = { run: handlers[suffix.slice('action.'.length)] };
    // The generated message schema contains workflow methods with no owning implementation.
    if (suffix === 'message') delete schema.methods;

    if (suffix === 'bot' || suffix === 'action.eval') schema.actionsOnly = true;
    types.push(buildRegisteredTypeDef({ name, module: manifest.id,
      security: suffix === 'bot' ? 'user-capability' : 'ordinary', schema, methods: [], actions }));
  }
  return manifest;
}
