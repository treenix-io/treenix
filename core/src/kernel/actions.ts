import { createHash } from 'node:crypto'
import { assertSafeSchema, validateValue, type ValidationError } from '#comp/validate'
import { KernelError } from '#errors'
import { createActionControl, createReadActionContext, createWriteActionContext } from '#kernel/action-context'
import { createActionDraft } from '#kernel/action-draft'
import { assertSupportedNeeds, resolveActionNeeds, type ResolvedActionNeeds } from '#kernel/action-needs'
import { createChangeBuilder } from '#kernel/change-builder'
import { changeSelectors, selectChangeStore, prepareChangeSet, type ChangeExecutor, type ChangeSetOptions } from '#kernel/changeset'
import type { CommandOptions, NodeActionBinding } from '#kernel/commands'
import { runWithActionContext } from '#kernel/current-action'
import { createSiftTest } from '#kernel/expr'
import { judgeGates } from '#kernel/gates'
import { componentEntries, createMigrator } from '#kernel/migrate'
import { checkPreconditions } from '#kernel/preconditions'
import { positionToRev } from '#kernel/position'
import { visibleNode } from '#kernel/projection'
import { assertPost } from '#kernel/post'
import { createReader, createReaderLedger, readerOperationCost, type ReaderLedger } from '#kernel/reader'
import { createRequestAdmission, serializeRequest } from '#kernel/request'
import { R, W, type ActRequest, type ActionDef, type ActionPieceDelivery, type ActionResult, type NestedActRequest, type OpId, type Outcome, type Position, type Principal, type StoredNode } from '#kernel/types'
import type { MutationSpan } from '#kernel/writer'
import { freeze } from '#util/freeze'
import { stableJson } from '#util/stable-json'

interface ParentAction {
  readonly depth: number
  readonly deadline: number
  readonly active: () => void
  readonly onlyRead: boolean
  readonly keyNamespace: Principal
  readonly ledger: ReaderLedger
}
const AsyncGenerator = Object.getPrototypeOf(async function* () {}).constructor

/** Validate the mutation key before it reaches durable dispatch. */
function assertMutationKey(opId: OpId | undefined): asserts opId is OpId {
  if (opId === undefined || typeof opId.epoch !== 'string' || opId.epoch.length === 0
    || !Number.isSafeInteger(opId.time) || opId.time < 0 || typeof opId.nonce !== 'string' || opId.nonce.length === 0)
    throw new KernelError('INVALID', 'A mutation key is required')
}

/** Reject action kinds and declared needs that this runtime cannot execute. */
function assertSupportedAction(action: ActionDef, options: CommandOptions): void {
  if (action.kind !== 'read' && action.io === true && options.io === undefined) throw new KernelError('UNAVAILABLE', 'Action I/O is not configured')
  if (action.kind !== 'read' && action.post !== undefined && action.handler !== undefined
    && (action.handler instanceof AsyncGenerator || Reflect.get(action.handler, 'implementation') instanceof AsyncGenerator))
    throw new KernelError('INVALID', 'A streaming action cannot declare post')
  assertSupportedNeeds(action.needs)
  if (action.kind !== 'read' && action.post !== undefined) assertPost(action.post)
}

/** Execute native actions through admitted reads and durable mutation decisions. */
export function createActionRuntime(options: CommandOptions) {
  const initialOptions = options
  const { writer, registry } = options
  const gates = Object.freeze([...options.gates])
  const migrator = createMigrator(type => ({ version: registry.type(type).version, steps: registry.security(type, 'migrate') ?? [] }))

  /** Own one request deadline and read set, including its nested action calls. */
  async function run(
    input: ActRequest,
    requestSignal?: AbortSignal,
    parent?: ParentAction,
    options: CommandOptions = initialOptions,
    deliver?: ActionPieceDelivery,
  ): Promise<Outcome> {
    const admission = createRequestAdmission(options.admission, requestSignal);
    const limits = options.limits();
    const allowance = options.budget('action');
    const depth = parent?.depth ?? 0;
    const keyNamespace = parent?.keyNamespace ?? admission.actor.principal;
    const budget = {
      ...allowance,
      deadline: Math.min(
        allowance.deadline,
        Date.now() + limits.actionMs,
        parent?.deadline ?? Infinity,
      ),
    };
    const ledger = parent?.ledger ?? createReaderLedger(budget, limits);
    const control = createActionControl(admission, budget.deadline, parent?.active);
    const assertActive = control.active;

    try {
      assertActive();
      if (depth > limits.actionDepth)
        throw new KernelError('BUDGET', 'Action nesting exceeds its limit');
      const owned = structuredClone(input);
      ledger.requestBytes += Buffer.byteLength(serializeRequest(owned));
      if (ledger.requestBytes > ledger.requestLimit)
        throw new KernelError('BUDGET', 'Action request budget exceeded');
      const request = freeze(owned);
      const opId = request.opId;
      const component = request.component ?? '';
      if (request.anchor !== undefined) assertMutationKey(request.anchor);

      const identity =
        opId === undefined
          ? undefined
          : {
              actor: admission.actor,
              opId,
              request: {
                kind: 'act',
                path: request.path,
                component,
                action: request.action,
                args: request.args,
                ...(request.anchor === undefined ? {} : { anchor: request.anchor }),
              },
            };
      if (identity !== undefined && !parent?.onlyRead) {
        assertMutationKey(opId);
        const replay = await writer.replay(identity, control.wait);
        if (replay !== undefined) return replay;
      }
      await options.prepareSource(budget, [{ history: '/' }], admission.signal);
      assertActive();

      const revision = options.registryRevision();
      const source = options.source(budget, ledger);

      /** Keep authorization tied to the registry used for this action. */
      function assertActionCurrent(): void {
        assertActive();
        if (options.registryRevision() !== revision)
          throw new KernelError('CONFLICT', 'Registry changed during action');
      }
      let callerReads = createReader({
        admission,
        writer,
        registry,
        source,
        budget,
        limits,
        ledger,
        projector: options.projector,
      });

      /** Resolve the addressed component and exact action through the caller's Reader. */
      async function classifyAction() {
        const result = await callerReads.read({ node: request.path });
        const copy = result.copies[0]!;
        assertActionCurrent();
        if (!('node' in copy)) throw copy.error;

        const node = copy.node;
        const bits = copy.bits;
        const target = componentEntries(node).find(([name]) => name === component);
        if (target === undefined) throw new KernelError('NOT_FOUND', 'Action component is absent');
        const ownComponent = target[1];
        const definition = registry.type(ownComponent.$type);
        if (!Object.hasOwn(definition.actions, request.action))
          throw new KernelError('NOT_FOUND', 'Action is absent');
        return { node, bits, ownComponent, definition, action: definition.actions[request.action] };
      }

      let classified: Awaited<ReturnType<typeof classifyAction>>;
      try {
        classified = await classifyAction();
      } catch (error) {
        if (
          identity !== undefined &&
          !parent?.onlyRead &&
          error instanceof KernelError &&
          error.code === 'NOT_FOUND'
        ) {
          const replay = await writer.replay(identity, control.wait);
          if (replay !== undefined) return replay;
        }
        throw error;
      }

      const { node, bits, ownComponent, definition, action } = classified;
      if (
        request.anchor !== undefined &&
        (action.kind === 'read' ||
          action.post !== undefined ||
          action.handler === undefined ||
          action.handler.constructor.name === 'AsyncFunction' ||
          Reflect.get(action.handler, 'implementation')?.constructor.name === 'AsyncFunction')
      )
        throw new KernelError('INVALID', 'Only a writing stream may continue an anchor');
      if (parent?.onlyRead && action.kind !== 'read')
        throw new KernelError('FORBIDDEN', 'This action may call only read actions');
      if (action.kind === 'read' && identity !== undefined && !parent?.onlyRead) {
        const replay = await writer.replay(identity, control.wait);
        if (replay !== undefined) return replay;
      }
      if (action.kind !== 'read') assertMutationKey(opId);
      let callerNode = node;
      const callerSource = source;
      const assertCallerCurrent = assertActionCurrent;

      /** Rechecks caller visibility independently of the executor's projection. */
      async function checkCallerReads(position: Position): Promise<void> {
        await checkPreconditions(callerReads.expect(), {
          index: writer.influence,
          position,
          read: callerReads.projectedNode,
          domains: callerReads.domains,
          dependency: callerReads.dependency,
          project: callerReads.project,
          work: callerReads.work,
          limits,
        });
      }

      /** Run checks and the handler once, then finish the supplied mutation span. */
      async function execute(span?: MutationSpan): Promise<Outcome> {
        assertActionCurrent();
        assertSupportedAction(action, options);
        const required = action.kind === 'write' ? R | W : R;
        if ((bits & required) !== required)
          throw new KernelError('FORBIDDEN', 'Action call rights are missing');
        assertSafeSchema(action.args, 'Action arguments');
        const errors: ValidationError[] = [];
        validateValue(request.args, action.args, 'args', errors);
        if (errors.length !== 0)
          throw new KernelError('INVALID', 'Action arguments violate their schema');

        await judgeGates(
          gates,
          {
            kind: 'act',
            path: request.path,
            component,
            action: request.action,
            args: request.args,
            origin: admission.origin,
          },
          admission.actor,
          { signal: control.signal, deadline: budget.deadline },
        );
        assertActionCurrent();
        if (action.kind === 'setuid') {
          return options.withNodeExecutor(
            { path: node.$path, id: node.$id, rev: node.$rev },
            budget,
            control.signal,
            control.wait,
            (binding) => perform(span, binding),
            ledger,
          );
        }
        return perform(span);
      }

      /** Keep one admitted executor and live draft while each resumption owns fresh reads and changes. */
      async function perform(span?: MutationSpan, binding?: NodeActionBinding): Promise<Outcome> {
        const executorAdmission =
          binding === undefined
            ? admission
            : createRequestAdmission(binding.admission, control.signal);
        const executorOptions = binding?.options ?? options;
        const executorControl =
          binding === undefined
            ? control
            : createActionControl(executorAdmission, budget.deadline, assertCallerCurrent);
        try {
          const active = binding === undefined ? assertCallerCurrent : executorControl.active;
          const targetOwner = callerSource.resolve(request.path);
          let expectedRev = callerNode.$rev;
          let source =
            binding === undefined ? callerSource : executorOptions.source(budget, ledger);
          let reads =
            binding === undefined
              ? callerReads
              : createReader({
                  admission: executorAdmission,
                  writer,
                  registry,
                  source,
                  budget,
                  limits,
                  ledger,
                  projector: executorOptions.projector,
                });
          let node =
            binding === undefined ? callerNode : visibleNode(migrator.migrate(binding.settings), 0);
          let ownComponent = componentEntries(node).find(([name]) => name === component)![1];
          let frameOpen = true;
          /** Refuse escaped work while the current frame is committed or waiting for its consumer. */
          function frameActive(): void {
            active();
            reads.check();
            if (!frameOpen) throw new KernelError('INVALID', 'Action frame has ended');
          }
          let builder = createChangeBuilder(frameActive, limits);
          let resolved: ResolvedActionNeeds;
          const draft =
            action.kind === 'read' ? undefined : createActionDraft(ownComponent, node, component);
          const keys = new Set<string>();
          let iterator: AsyncGenerator<unknown, unknown, undefined> | undefined;
          let natural = false;
          let streaming = false;

          /** Commit inner calls independently under the original stream anchor and stable caller namespace. */
          async function callNestedAction(input: NestedActRequest): Promise<unknown> {
            frameActive();
            if (Object.hasOwn(input, 'opId') || Object.hasOwn(input, 'anchor'))
              throw new KernelError('INVALID', 'Nested mutation keys belong to the runtime');
            serializeRequest(input);
            const nestedRequest = freeze(structuredClone(input));
            const key = nestedRequest.key;
            if (key !== undefined) {
              if (typeof key !== 'string' || key.length === 0 || keys.has(key))
                throw new KernelError('INVALID', 'Nested call keys must be unique and nonempty');
              keys.add(key);
            }
            const onlyRead = action.kind === 'read' || action.post !== undefined;
            const parentKey = streaming && span !== undefined ? span.anchor.opId : opId;
            const nestedOpId =
              !onlyRead && key !== undefined && parentKey !== undefined
                ? {
                    epoch: parentKey.epoch,
                    time: parentKey.time,
                    nonce:
                      'nested:' +
                      createHash('sha256')
                        .update(stableJson([keyNamespace, parentKey, key]))
                        .digest('hex'),
                  }
                : undefined;
            const outcome = await executorControl.wait(
              run(
                {
                  path: nestedRequest.path,
                  component: nestedRequest.component,
                  action: nestedRequest.action,
                  args: nestedRequest.args,
                  opId: nestedOpId,
                },
                executorControl.signal,
                {
                  depth: depth + 1,
                  deadline: budget.deadline,
                  active: frameActive,
                  onlyRead,
                  keyNamespace,
                  ledger,
                },
                executorOptions,
                deliver,
              ),
            );
            frameActive();
            return outcome.value;
          }
          const contextOptions = () => ({
            node,
            needs: resolved.needs,
            reads,
            caller: admission.actor,
            executor: executorAdmission.actor,
            active: frameActive,
            nested: callNestedAction,
          });
          const writeContext =
            action.kind === 'read'
              ? undefined
              : createWriteActionContext(
                  contextOptions,
                  () => builder.change,
                  action.io === true ? executorOptions.io : undefined,
                );
          const context = writeContext ?? createReadActionContext(contextOptions);

          /** Judge this frame at its genuine position, then retain only its accepted own image. */
          async function finishFrame(final: boolean, value: unknown): Promise<Outcome> {
            const changes = builder.finish();
            if (span === undefined) {
              await writer.read(source.domains, async () => {
                frameActive();
                await admission.validate(source.auth);
                await checkPreconditions(reads.expect(), {
                  index: writer.influence,
                  position: writer.stream.cursor().pos,
                  inclusivePosition: true,
                  read: reads.projectedNode,
                  domains: reads.domains,
                  dependency: reads.dependency,
                  project: reads.project,
                  work: reads.work,
                  limits,
                });
                frameActive();
              });
              return { value };
            }
            await executorOptions.prepareSource(
              budget,
              changeSelectors(changes),
              executorControl.signal,
            );
            frameActive();
            source = executorOptions.source(budget, ledger);
            const ownership = createReader({
              admission: executorAdmission,
              writer,
              registry,
              source,
              budget,
              limits,
              ledger,
              projector: executorOptions.projector,
            });
            const targetStore = source.resolve(request.path).store;
            const store = changes.some((change) => change.op === 'restore')
              ? await writer.read(source.domains, async () => {
                  await executorAdmission.validate(source.auth);
                  return selectChangeStore(changes, source, ownership, targetStore);
                })
              : await selectChangeStore(changes, source, ownership, targetStore);
            if (final && streaming && store !== targetStore)
              throw new KernelError(
                'CROSS_DOMAIN',
                'Final stream decisions belong to the action target Store',
              );
            const ownerDependencies = ownership.expect().dependencies ?? [];
            let ownImage: StoredNode | null | undefined;
            const prepare = async (pos: Position) => {
              frameActive();
              await admission.validate(source.auth);
              if (binding !== undefined) {
                await binding.validate(source.auth);
                await checkCallerReads(pos);
              }
              frameActive();
              const prepared = await prepareChangeSet(
                {
                  store,
                  cache: writer.cache,
                  registry,
                  limits,
                  budget: reads.remainingBudget(),
                  readCost: readerOperationCost(ledger),
                  blobs: executorOptions.blobs,
                  boundary: executorOptions.boundary,
                  resolve: (path) => source.resolve(path).store,
                  readBefore: source.auth.node,
                  capabilities: executorOptions.capabilities(budget, ledger),
                  preconditions: {
                    index: writer.influence,
                    read: reads.projectedNode,
                    domains: reads.domains,
                    dependency: reads.dependency,
                    project: reads.project,
                    work: reads.work,
                    limits,
                  },
                },
                changes,
                pos,
                {
                  executor: executorAdmission.actor.principal,
                  caller: admission.actor.principal,
                  actor: executorAdmission.actor,
                  expect: {
                    ...reads.expect(),
                    dependencies: [...(reads.expect().dependencies ?? []), ...ownerDependencies],
                  },
                  action: {
                    type: definition.name,
                    action: request.action,
                    path: request.path,
                    targets: resolved.targets,
                  },
                },
              );
              executorOptions.validate(prepared);
              ownImage = prepared.writes.find((write) => write.path === request.path)?.node;
              frameActive();
              return { ...prepared, ...(value === undefined ? {} : { value }), check: frameActive };
            };
            if (final) return span.finish(store, source.domains, prepare);
            const pos = await span.step(store, source.domains, prepare);
            if (ownImage !== undefined && ownImage !== null) {
              binding?.acceptOwnStep(ownImage);
              expectedRev = positionToRev(ownImage.$pos);
            }
            return { pos };
          }

          /** Fresh call rights and reads preserve the admitted target while dropping the accepted frame's read set. */
          async function nextFrame(): Promise<void> {
            active();
            const currentSource = options.source(budget, ledger);
            if (
              currentSource.resolve(request.path).id !== targetOwner.id ||
              currentSource.resolve(request.path).store !== targetOwner.store
            )
              throw new KernelError('CONFLICT', 'Action target changed between steps');
            callerReads = createReader({
              admission,
              writer,
              registry,
              source: currentSource,
              budget,
              limits,
              ledger,
              projector: options.projector,
            });
            let current: Awaited<ReturnType<typeof classifyAction>>;
            try {
              current = await classifyAction();
            } catch (error) {
              if (error instanceof KernelError && error.code === 'NOT_FOUND')
                throw new KernelError('CONFLICT', 'Action call projection changed between steps');
              throw error;
            }
            if (current.node.$id !== callerNode.$id || current.node.$rev !== expectedRev)
              throw new KernelError('CONFLICT', 'Action configuration changed between steps');
            const required = action.kind === 'write' ? R | W : R;
            if ((current.bits & required) !== required)
              throw new KernelError('FORBIDDEN', 'Action call rights are missing');
            callerNode = current.node;
            source = binding === undefined ? currentSource : executorOptions.source(budget, ledger);
            if (binding !== undefined)
              await writer.read(source.domains, () => binding.validate(source.auth));
            reads =
              binding === undefined
                ? callerReads
                : createReader({
                    admission: executorAdmission,
                    writer,
                    registry,
                    source,
                    budget,
                    limits,
                    ledger,
                    projector: executorOptions.projector,
                  });
            node =
              binding === undefined
                ? callerNode
                : visibleNode(migrator.migrate(binding.settings), 0);
            ownComponent = componentEntries(node).find(([name]) => name === component)![1];
            draft?.rebase(ownComponent, node);
            builder.discard();
            builder = createChangeBuilder(frameActive, limits);
            frameOpen = true;
            resolved = await resolveActionNeeds(action.needs, request.path, reads, limits);
            checkPre();
          }
          /** Evaluate declared preconditions against the current frame's actual reads and executor settings. */
          function checkPre(): void {
            frameActive();
            if (
              action.pre !== undefined &&
              !createSiftTest(action.pre, limits)({ node, needs: resolved.needs }, reads.work)
            )
              throw new KernelError('CONFLICT', 'Action precondition does not hold');
          }
          try {
            active();
            if (binding !== undefined)
              await judgeGates(
                gates,
                {
                  kind: 'act',
                  path: request.path,
                  component,
                  action: request.action,
                  args: request.args,
                  origin: admission.origin,
                },
                executorAdmission.actor,
                { signal: executorControl.signal, deadline: budget.deadline },
              );
            resolved = await resolveActionNeeds(action.needs, request.path, reads, limits);
            checkPre();
            let value: unknown;
            if (action.handler !== undefined) {
              let pending: ActionResult;
              if (action.kind === 'read') {
                const handler = action.handler;
                pending = runWithActionContext(context, frameActive, () =>
                  handler.call(freeze(ownComponent), context, structuredClone(request.args)),
                );
              } else {
                const handler = action.handler;
                pending = runWithActionContext(context, frameActive, () =>
                  handler.call(draft!.draft, writeContext!, structuredClone(request.args)),
                );
              }
              if ('next' in pending) {
                iterator = pending;
                if (action.kind !== 'read' && action.post !== undefined)
                  throw new KernelError('INVALID', 'A streaming action cannot declare post');
                if (deliver === undefined)
                  throw new KernelError(
                    'UNAVAILABLE',
                    'Streaming action requires an owned consumer',
                  );
                streaming = true;
                if (span !== undefined)
                  await span.beginStream({
                    executor: executorAdmission.actor.principal,
                    target: node.$id,
                  });
                while (true) {
                  if (span !== undefined)
                    await writer.read(source.domains, () => span.validateAnchor());
                  const step = await executorControl.wait(
                    runWithActionContext(context, frameActive, () => iterator!.next()),
                  );
                  frameActive();
                  if (step.done) {
                    natural = true;
                    value = step.value;
                    break;
                  }
                  const data = structuredClone(step.value);
                  if (Buffer.byteLength(serializeRequest(data)) > limits.requestBytes)
                    throw new KernelError('BUDGET', 'Action piece exceeds its budget');
                  draft?.checkpoint(builder.change);
                  const outcome = await finishFrame(false, undefined);
                  frameOpen = false;
                  await executorControl.wait(
                    deliver(
                      { ...(outcome.pos === undefined ? {} : { pos: outcome.pos }), data },
                      executorControl.signal,
                    ),
                  );
                  await nextFrame();
                }
              } else {
                if (request.anchor !== undefined)
                  throw new KernelError('INVALID', 'Only a stream may continue an anchor');
                value = await executorControl.wait(pending);
                frameActive();
              }
              draft?.finish(builder.change);
            } else if (action.kind !== 'read' && action.post !== undefined) {
              for (const [name, ops] of Object.entries(action.post)) {
                if (
                  name !== '' &&
                  (!Object.hasOwn(action.needs ?? {}, name) ||
                    !Object.hasOwn(resolved.targets, name))
                )
                  throw new KernelError('INVALID', 'The post target was not declared as a need');
                if (Object.keys(ops).length !== 0)
                  for (const path of name === '' ? [request.path] : resolved.targets[name])
                    builder.change.patch(path, ops);
              }
            }
            return await finishFrame(true, value);
          } finally {
            frameOpen = false;
            if (iterator !== undefined && !natural) {
              // IteratorClose can queue behind an uncooperative next; it cannot hold the genuine session open.
              void runWithActionContext(context, frameActive, () =>
                iterator!.return(undefined),
              ).catch((error) => console.error(error));
            }
            draft?.discard();
            builder.discard();
          }
        } finally {
          if (binding !== undefined) executorControl.close();
        }
      }

      if (action.kind === 'read') return await execute();
      assertMutationKey(opId);
      return await writer.mutate(
        {
          actor: admission.actor,
          opId,
          anchorLookupCost: readerOperationCost(ledger),
          request: {
            kind: 'act',
            path: request.path,
            component,
            action: request.action,
            args: request.args,
            ...(request.anchor === undefined ? {} : { anchor: request.anchor }),
          },
          ...(request.anchor === undefined
            ? {}
            : {
                anchor: request.anchor,
                stream: {
                  executor: action.kind === 'setuid' ? `n:${node.$id}` : admission.actor.principal,
                  target: node.$id,
                },
              }),
        },
        execute,
        control.wait,
      );
    } catch (error) {
      if (error instanceof KernelError && error.code === 'BUDGET') ledger.failure = error;
      throw error;
    } finally {
      control.close();
    }
  }

  return { act: (input: ActRequest, requestSignal?: AbortSignal, deliver?: ActionPieceDelivery) => run(input, requestSignal, undefined, initialOptions, deliver) }
}
