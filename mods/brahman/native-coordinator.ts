import { KernelError } from '@treenx/core/errors';
import type { Node, OpId, Session } from '@treenx/core/kernel/types';
import { PageConfig } from '#brahman/types';
import { component, nativeNode, type NativeSessionState } from '#brahman/native-state';
import { decodeFlow } from '#brahman/native-flow';
import type { BrahmanRunArgs } from '#brahman/native-ports';

/** Coordinate committed native actions without nesting writes into a pending action. */
export class NativeConversation {
  constructor(private readonly session: Session, private readonly key: () => OpId) {}

  /** Read the owning conversation after its preceding action has committed. */
  async state(args: BrahmanRunArgs): Promise<NativeSessionState> {
    return component<NativeSessionState>(await nativeNode(this.session, `${args.botPath}/sessions/${args.userId}`), 'brahman.session');
  }

  /** Execute one exact native action and preserve its pending outcome. */
  async act(path: string, action: string, args: unknown, component?: string): Promise<unknown> {
    return (await this.session.act({ path, component, action, args, opId: this.key() }).outcome).value;
  }

  /** Enumerate complete children; a partial action palette cannot execute silently. */
  async children(path: string): Promise<readonly Node[]> {
    const result = await this.session.read({ children: path });
    if (result.next !== undefined) throw new KernelError('BUDGET', 'Conversation children exceed the native window');
    return result.copies.map(copy => {
      if ('error' in copy) throw copy.error;
      return copy.node;
    });
  }

  /** Find command pages through the actual reader, including authored nested pages. */
  async command(args: BrahmanRunArgs, command: string): Promise<string | undefined> {
    const queue = [`${args.botPath}/pages`];
    let visited = 0;
    while (queue.length !== 0) {
      if (++visited > 128) throw new KernelError('BUDGET', 'Conversation page lookup exceeds its bound');
      const directory = queue.shift()!;
      for (const node of await this.children(directory)) {
        if (node.$type === 't.dir') queue.push(node.$path);
        else if (node.$type === 'brahman.page') {
          const page = component(node, PageConfig);
          if (page.command === command || page.command === `/${command}`) return node.$path;
          queue.push(node.$path);
        }
      }
    }
    return undefined;
  }

  /** Commit navigation before dispatching the page's ordered native palette. */
  async page(path: string, args: BrahmanRunArgs, param?: string, budget = { remaining: 128 }): Promise<void> {
    const root = `${args.botPath}/pages`;
    if (!path.startsWith(`${root}/`)) throw new KernelError('NOT_FOUND', 'Page is outside the owning bot');
    const page = component(await nativeNode(this.session, path), PageConfig);
    await this.act(`${args.botPath}/sessions/${args.userId}`, 'enterPage', param === undefined ? { page: path } : { page: path, param });
    const children = await this.children(`${path}/_actions`);
    const byPath = new Map(children.map(node => [node.$path, node]));
    const ordered: string[] = [];
    for (const position of page.positions) {
      if (!byPath.has(position)) throw new KernelError('NOT_FOUND', 'Ordered page action is missing');
      ordered.push(position);
    }
    for (const child of children) if (!page.positions.includes(child.$path)) ordered.push(child.$path);
    await this.actions(ordered, args, budget);
  }

  /** Resume a persisted question queue after accepting its matching input. */
  async resume(args: BrahmanRunArgs): Promise<boolean> {
    const wait = (await this.state(args)).data.wait;
    if (wait === undefined || (wait.type === 'text' ? args.update.text : args.update.photo) === undefined) return false;
    await this.act(`${args.botPath}/sessions/${args.userId}`, 'resumeWait', args);
    await this.actions(wait.remaining, args);
    return true;
  }

  /** Dispatch flow directives only after their owning native operation commits. */
  async actions(paths: readonly string[], args: BrahmanRunArgs, budget = { remaining: 128 }): Promise<void> {
    for (let index = 0; index < paths.length; index++) {
      if (--budget.remaining < 0) throw new KernelError('BUDGET', 'Conversation action sequence exceeds its bound');
      const flow = decodeFlow(await this.act(paths[index], 'run', args));
      if (flow?.call !== undefined) {
        const call = flow.call;
        const value = await this.act(call.path, call.action, call.args, call.component);
        if (call.saveTo !== undefined) {
          if (value === undefined) throw new KernelError('INVALID', 'Called action returned no saved value');
          await this.act(`${args.botPath}/sessions/${args.userId}`, 'saveResult', { field: call.saveTo, value });
        }
      }
      if (flow?.broadcast !== undefined) for (const target of flow.broadcast) {
        const targetArgs = { ...args, userId: target.userId, chatId: target.chatId, lang: target.lang };
        await this.act(args.botPath, 'initialize', targetArgs);
        await this.actions([target.action], targetArgs, budget);
      }
      if (flow?.page !== undefined) await this.page(flow.page, args, undefined, budget);
      if (flow?.action !== undefined) await this.actions([flow.action], args, budget);
      if (flow?.emittedText !== undefined) {
        const command = /^\/([^\s]+)(?:\s+(.*))?$/.exec(flow.emittedText);
        if (command === null) throw new KernelError('INVALID', 'Emitted command is invalid');
        const page = await this.command(args, command[1]);
        if (page === undefined) throw new KernelError('NOT_FOUND', 'Emitted command has no page');
        await this.page(page, args, command[2], budget);
      }
      const wait = (await this.state(args)).data.wait;
      if (wait !== undefined) {
        await this.act(`${args.botPath}/sessions/${args.userId}`, 'queueWait', { remaining: paths.slice(index + 1) });
        return;
      }
      if (flow?.stop) return;
    }
  }
}
