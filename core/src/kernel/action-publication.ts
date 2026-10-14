import { createHash } from 'node:crypto';
import { assertSafeSchema } from '#comp/validate';
import { KernelError } from '#errors';
import { isSelector, keys, text } from '#kernel/input-boundary';
import { assertPost } from '#kernel/post';
import { sourceAction, verifyActionSource } from '#kernel/source-action';
import { getActionLifetime } from '#kernel/current-action';
import type {
  ActionDef,
  Node,
  Registry,
  SourceActionDefinition,
  StoredNode,
  WriteActionContext,
  PublishedActionSource,
} from '#kernel/types';
import { isRecord } from '#util/is-record';

export const ACTION_PUBLICATION_PREFIX = '/sys/uix-action.';

/** Give every owning type/action pair one collision-free canonical snapshot address. */
export function actionPublicationPath(type: string, action: string): string {
  return (
    ACTION_PUBLICATION_PREFIX +
    createHash('sha256')
      .update(JSON.stringify([type, action]))
      .digest('hex')
  );
}

/** Validate untrusted declaration data without admitting handlers, owners or security registrations. */
export function sourceDefinition(value: unknown): SourceActionDefinition {
  if (
    !isRecord(value) ||
    !keys(value, ['kind', 'args', 'needs', 'pre', 'io', 'post']) ||
    (value.kind !== 'read' && value.kind !== 'write' && value.kind !== 'setuid')
  )
    throw new KernelError('INVALID', 'Invalid source action definition');
  assertSafeSchema(value.args, 'source action arguments');
  if (
    value.needs !== undefined &&
    (!isRecord(value.needs) || !Object.values(value.needs).every(isSelector))
  )
    throw new KernelError('INVALID', 'Invalid source action needs');
  if (value.pre !== undefined && !isRecord(value.pre))
    throw new KernelError('INVALID', 'Invalid source action precondition');
  if (value.io !== undefined && typeof value.io !== 'boolean')
    throw new KernelError('INVALID', 'Invalid source action I/O');
  if (value.kind === 'read' && (value.io !== undefined || value.post !== undefined))
    throw new KernelError('INVALID', 'Read source cannot declare writing effects');
  if (value.post !== undefined) assertPost(value.post);
  // Persisted declarations cross the sandbox/data boundary; the assertions above decode their native shape.
  return value as SourceActionDefinition;
}

/** Retain the owning action's data contract while replacing only its implementation. */
function definitionOf(action: ActionDef): SourceActionDefinition {
  const common = {
    args: action.args,
    ...(action.needs === undefined ? {} : { needs: action.needs }),
    ...(action.pre === undefined ? {} : { pre: action.pre }),
  };
  if (action.kind === 'read') return { ...common, kind: action.kind };
  return {
    ...common,
    kind: action.kind,
    ...(action.io === undefined ? {} : { io: action.io }),
    ...(action.post === undefined ? {} : { post: action.post }),
  };
}

/** Decode an accepted protected source snapshot before installing or cold-restoring its generation. */
export function publishedAction(node: Node | StoredNode): PublishedActionSource {
  if (
    node.$type !== 'uix.action-publication' ||
    !text(node.type) ||
    !text(node.module) ||
    !text(node.action) ||
    typeof node.source !== 'string' ||
    !text(node.draft) ||
    !text(node.draftRev) ||
    typeof node.stream !== 'boolean' ||
    node.$path !== actionPublicationPath(node.type, node.action)
  )
    throw new KernelError('INVALID', 'Malformed action publication');
  return {
    type: node.type,
    module: node.module,
    action: node.action,
    source: node.source,
    draft: node.draft,
    draftRev: node.draftRev,
    stream: node.stream,
    definition: sourceDefinition(node.definition),
  };
}

/** Replace within the same immutable module; its types, owners and security/open handlers stay intact. */
export function installPublishedAction(registry: Registry, published: PublishedActionSource): void {
  const definition = registry.type(published.type);
  if (definition.module !== published.module)
    throw new KernelError('FORBIDDEN', 'Action publication owner differs from type owner');
  const manifest = registry.module(published.module);
  const action = sourceAction(published, manifest);
  const sources = [
    ...(manifest.actionSources ?? []).filter(
      (source) => source.type !== published.type || source.action !== published.action,
    ),
    published,
  ].sort((a, b) => a.type.localeCompare(b.type) || a.action.localeCompare(b.action));
  registry.publish({
    ...manifest,
    actionSources: sources,
    types: manifest.types.map((type) =>
      type.name !== published.type
        ? type
        : {
            ...type,
            actions: { ...type.actions, [published.action]: action },
          },
    ),
  });
}

/** Accept one actual administrator's immutable draft snapshot through the native writer and read set. */
export function publishAction(registry: Registry) {
  return async (context: WriteActionContext, args: unknown): Promise<void> => {
    await context.requireAdmin();
    if (
      !isRecord(args) ||
      !text(args.draft) ||
      !text(args.action) ||
      (args.stream !== undefined && typeof args.stream !== 'boolean')
    )
      throw new KernelError('INVALID', 'Action publication requires a draft and action');
    const type = context.node.name;
    if (!text(type) || !text(context.node.module))
      throw new KernelError('INVALID', 'Type ownership is absent');
    const owner = registry.type(type);
    if (owner.module !== context.node.module)
      throw new KernelError('FORBIDDEN', 'Action source differs from type owner');
    const old = owner.actions[args.action];
    if (args.definition === undefined && old === undefined)
      throw new KernelError('INVALID', 'A new action requires a declaration');
    const definition =
      args.definition === undefined ? definitionOf(old) : sourceDefinition(args.definition);
    const prior = registry
      .module(owner.module)
      .actionSources?.find((source) => source.type === type && source.action === args.action);
    const stream = args.stream ?? prior?.stream ?? false;
    if (stream && definition.kind !== 'read' && definition.post !== undefined)
      throw new KernelError('INVALID', 'Streaming source cannot declare post');
    const result = await context.read.read({ node: args.draft });
    const copy = result.copies[0];
    if ('error' in copy) throw copy.error;
    const draft = copy.node;
    if (draft.$type !== 'uix.source' || typeof draft.source !== 'string')
      throw new KernelError('INVALID', 'A source draft is required');
    await verifyActionSource(draft.source, stream, getActionLifetime());
    const path = actionPublicationPath(type, args.action);
    await context.requireReadWrite(path);
    context.change.put({
      $path: path,
      $type: 'uix.action-publication',
      type,
      module: owner.module,
      action: args.action,
      source: draft.source,
      draft: draft.$path,
      draftRev: draft.$rev,
      stream,
      definition,
    });
    const locators = context.node.actionPublications;
    if (locators !== undefined && !isRecord(locators))
      throw new KernelError('INVALID', 'Malformed action publications');
    context.change.patch(context.node.$path, {
      $set: { actionPublications: { ...locators, [args.action]: path } },
    });
  };
}
