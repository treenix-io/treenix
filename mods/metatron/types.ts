import { getCtx, registerType } from '@treenity/core/comp';

/** AI orchestrator config — model, system prompt, session tracking */
export class MetatronConfig {
  model = 'claude-opus-4-6';
  /** @format textarea */
  systemPrompt = '';
  sessionId = '';
  lastRun = 0;
}

/** AI task — prompt with status and result of LLM execution */
export class MetatronTask {
  /** @format textarea */
  prompt = '';
  status: 'pending' | 'running' | 'done' | 'error' = 'pending';
  /** @format textarea */
  result = '';
  /** @format textarea */
  log = '';
  createdAt = 0;
  /** Queued user messages to process after current run */
  injected: string[] = [];
  /** Source task path if forked */
  forkedFrom = '';
  /** Log position where the fork was made */
  forkIndex = 0;

  /** @description Stop the running task */
  async stop() {
    if (this.status !== 'running') throw new Error('task is not running');
    const { node } = getCtx();
    const configPath = node.$path.replace(/\/tasks\/[^/]+$/, '');
    const { abortQuery } = await import('./claude');
    abortQuery(configPath);
  }

  /** @description Queue a follow-up message for the running task */
  async inject(data: { /** Message text */ text: string }) {
    if (!data.text?.trim()) throw new Error('text is required');
    this.injected.push(data.text.trim());
  }

  /** @description Fork this conversation at a specific log position */
  async fork(data: { /** Character position in log to fork at */ atIndex: number }) {
    const { tree, node } = getCtx();
    const { createNode } = await import('@treenity/core');
    const configPath = node.$path.replace(/\/tasks\/[^/]+$/, '');
    const id = `t-${Date.now()}`;
    const forkPath = `${configPath}/tasks/${id}`;
    const logSlice = this.log.slice(0, data.atIndex);

    await tree.set(createNode(forkPath, 'metatron.task', {
      prompt: `[forked from ${node.$path.split('/').at(-1)}] ${this.prompt}`,
      status: 'done',
      result: logSlice,
      log: logSlice,
      createdAt: Date.now(),
      forkedFrom: node.$path,
      forkIndex: data.atIndex,
    }));

    return { taskPath: forkPath };
  }
}

/** Permission rule — controls which tools Metatron is allowed to use */
export class MetatronPermission {
  /** Tool name or glob pattern: 'mcp__treenity__*', '*' */
  tool = '';
  /** Optional input.path pattern */
  pathPattern = '';
  policy: 'allow' | 'deny' = 'allow';
  createdAt = 0;
}

/** Reusable prompt template for quick task creation */
export class MetatronTemplate {
  name = '';
  /** @format textarea */
  prompt = '';
  category = '';
}

/** Modular prompt fragment — learned skill or injected capability */
export class MetatronSkill {
  name = '';
  /** @format textarea */
  prompt = '';
  enabled = true;
  category = '';
  updatedAt = 0;
}

/** Multi-task workspace — side-by-side columns of conversations */
export class MetatronWorkspace {
  name = '';
  columns: string[] = [];

  /** @description Add a task as a column */
  async addColumn(data: { /** Task path */ taskPath: string }) {
    if (!data.taskPath) throw new Error('taskPath is required');
    if (this.columns.includes(data.taskPath)) return;
    this.columns.push(data.taskPath);
  }

  /** @description Remove a column by task path */
  async removeColumn(data: { /** Task path */ taskPath: string }) {
    const idx = this.columns.indexOf(data.taskPath);
    if (idx === -1) throw new Error('column not found');
    this.columns.splice(idx, 1);
  }
}

registerType('metatron.config', MetatronConfig);
registerType('metatron.task', MetatronTask);
registerType('metatron.permission', MetatronPermission);
registerType('metatron.template', MetatronTemplate);
registerType('metatron.skill', MetatronSkill);
registerType('metatron.workspace', MetatronWorkspace);
