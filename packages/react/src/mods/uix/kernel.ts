import { declareClientType } from '@treenx/core/comp/client-declaration';
import type { Class } from '@treenx/core';
import type { NativeModuleDeployment } from '@treenx/core/kernel/manifest';
import { declareOpenModule } from '@treenx/core/kernel/module-declaration';
import { buildTypeDef } from '@treenx/core/kernel/typedef';
import { readSchemasFromDir } from '@treenx/core/schema/load';
import { A, R, W, type RuleInput, type ActionDef } from '@treenx/core/kernel/types';
import { UixSource } from './uix-source';
import { compileDraftAction, verifyDraftAction } from './native-draft';
import { UixMcpTools } from './mcp';

/** Administrator-owned immutable snapshot, separate from its ordinary editable source draft. */
class UixPublication {
  type = '';
  module = '';
  source = '';
  draft = '';
  draftRev = '';
}

class UixActionPublication extends UixPublication {
  action = '';
  definition = {};
  stream = false;
}

const publicationDeclaration = declareClientType('uix.publication', UixPublication);
const actionPublicationDeclaration = declareClientType('uix.action-publication', UixActionPublication);

/** Published source is readable, while only the instance administrator may replace it. */
function publicationRights(input: RuleInput): number {
  return input.admin ? R | W | A : R;
}

/** Compile the existing protected publication types and draft actions under their native owner. */
export default function createNativeUix(): NativeModuleDeployment {
  const id = '@treenx/react/uix';
  const classes: Readonly<Record<string, Class<object>>> = {
    'uix.source': UixSource,
    [publicationDeclaration.type]: UixPublication,
    [actionPublicationDeclaration.type]: UixActionPublication,
    'uix.mcp': UixMcpTools,
  };
  const actions: Readonly<Record<string, Readonly<Record<string, ActionDef>>>> = {
    'uix.source': { verify_view: verifyDraftAction },
    'uix.mcp': { compile_view: compileDraftAction },
  };
  const owned = readSchemasFromDir(new URL('./schemas/', import.meta.url).pathname).map(schema => {
    const cls = classes[schema.$id];
    const type = buildTypeDef(cls, { name: schema.$id, module: id, security: 'ordinary', schema, actions: actions[schema.$id] });
    return { cls, schema, type };
  });
  return { manifest: { ...declareOpenModule(id, owned.flatMap(({ cls, schema, type }) => [
    { type: type.name, context: 'class', handler: cls },
    { type: type.name, context: 'schema', handler: () => schema },
    ...Object.entries(type.actions).map(([name, handler]) => ({ type: type.name, context: `action:${name}`, handler })),
  ])), types: owned.map(entry => entry.type), security: [
    { type: 'uix.publication', context: 'acl', handler: publicationRights },
    { type: 'uix.action-publication', context: 'acl', handler: publicationRights },
  ] } };
}
