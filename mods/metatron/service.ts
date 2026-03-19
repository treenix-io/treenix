// Metatron — AI task queue + Claude CLI service
// 1. action:task — creates task nodes in /metatron inbox
// 2. service — watches for pending tasks, auto-invokes Claude CLI via MCP
// Prompt lives in the node (systemPrompt). First run sends full prompt.
// Subsequent runs (with sessionId) send just "check inbox" — Claude already has context.
// Streaming: progress visible on running task nodes in real-time.
// Abort: user can stop a running task via task.stop() → abortQuery in claude.ts.
// Inject: user can queue messages via task.inject() → processed after current run.

import { createNode, type NodeData, register } from '@treenity/core';
import { type ServiceCtx } from '@treenity/core/contexts/service';
import { type ActionCtx } from '@treenity/core/server/actions';
import { buildClaims, withAcl } from '@treenity/core/server/auth';
import { debouncedWrite } from '@treenity/core/util/debounced-write';
import { closeSession, invokeClaude } from './claude';
import { uniqueMentionPaths } from './mentions';
import { type PermissionRule } from './permissions';

const log = (msg: string) => console.log(`[metatron] ${msg}`);

const CHECK_INBOX = 'Check your inbox at /metatron/inbox. Process all pending tasks.';

// ── Load enabled skills from /metatron/skills/* ──

async function loadSkills(ctx: ServiceCtx, configPath: string): Promise<string> {
  try {
    const { items } = await ctx.tree.getChildren(`${configPath}/skills`);
    const enabled = items.filter(s => s.$type === 'metatron.skill' && s.enabled && s.prompt);
    if (!enabled.length) return '';

    const sections = enabled.map(s => {
      const name = String(s.name || s.$path.split('/').at(-1));
      return `### ${name}\n${String(s.prompt)}`;
    });

    log(`  loaded ${enabled.length} skill(s)`);
    return '\n\n## Active Skills\n\n' + sections.join('\n\n');
  } catch {
    return '';
  }
}

// ── Load permission rules from /metatron/permissions/* ──

async function loadPermissions(ctx: ServiceCtx, configPath: string): Promise<PermissionRule[]> {
  try {
    const { items } = await ctx.tree.getChildren(`${configPath}/permissions`);
    const rules = items
      .filter(n => n.$type === 'metatron.permission' && n.tool)
      .map(n => ({
        tool: String(n.tool),
        pathPattern: String(n.pathPattern || ''),
        policy: (n.policy as PermissionRule['policy']) || 'allow',
      }));
    if (rules.length) log(`  loaded ${rules.length} permission rule(s)`);
    return rules;
  } catch {
    return [];
  }
}

// ── Resolve @/path mentions in prompts → context section ──
// Uses ACL-wrapped tree scoped to the task creator's permissions.
// withAcl.get() returns undefined for denied paths — no existence leakage.

const SENSITIVE_RE = /(password|secret|token|key|hash|credentials|apiKey|api_key)/i;

export async function resolveContext(
  store: import('@treenity/core/tree').Tree,
  prompts: string[],
  createdBy: string | null,
): Promise<string> {
  const allPaths = new Set<string>();
  for (const p of prompts) {
    for (const path of uniqueMentionPaths(p)) allPaths.add(path);
  }

  if (!allPaths.size) return '';

  // ACL-scoped tree for the task creator
  const claims = createdBy ? await buildClaims(store, createdBy) : ['public'];
  const userTree = withAcl(store, createdBy, claims);

  const MAX_MENTIONS = 5;
  const paths = [...allPaths].slice(0, MAX_MENTIONS);
  const sections: string[] = [];

  for (const path of paths) {
    try {
      const node = await userTree.get(path);
      if (!node) {
        sections.push(`### ${path}\n(not found or access denied)`);
        continue;
      }
      // Include type + top-level fields, strip system and sensitive fields
      const summary: Record<string, unknown> = { $type: node.$type };
      // use getComponents for this loop
      for (const [k, v] of Object.entries(node)) {
        if (k.startsWith('$')) continue;
        if (SENSITIVE_RE.test(k)) continue;
        if (typeof v === 'object' && v && '$type' in v) {
          // Named component — filter its keys too
          const comp: Record<string, unknown> = { $type: (v as any).$type };
          for (const [ck, cv] of Object.entries(v as Record<string, unknown>)) {
            if (ck.startsWith('$') || SENSITIVE_RE.test(ck)) continue;
            comp[ck] = typeof cv === 'string' && cv.length > 500 ? cv.slice(0, 500) + '...' : cv;
          }
          summary[k] = comp;
          continue;
        }
        if (typeof v === 'string' && v.length > 500) {
          summary[k] = v.slice(0, 500) + '...';
        } else {
          summary[k] = v;
        }
      }
      sections.push(`### ${path}\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\``);
    } catch {
      sections.push(`### ${path}\n(error reading node)`);
    }
  }

  return '\n\n## Referenced Nodes\n\n' + sections.join('\n\n');
}

// ── Action: create a task ──

/** @description Create a task for AI processing in the Metatron inbox */
register('metatron.config', 'action:task', async (ctx: ActionCtx, data: { prompt: string }) => {
  if (!data.prompt) throw new Error('prompt is required');

  const id = `t-${Date.now()}`;
  const taskPath = `${ctx.node.$path}/tasks/${id}`;

  await ctx.tree.set(createNode(taskPath, 'metatron.task', {
    prompt: data.prompt,
    status: 'pending',
    createdAt: Date.now(),
    createdBy: ctx.userId ?? null,
  }));

  log(`task created: ${taskPath} — "${data.prompt.slice(0, 80)}"`);
  return { taskPath };
}, { description: 'Create a task for AI', params: 'prompt' });

// ── Service: watch inbox, auto-invoke Claude ──

register('metatron.config', 'service', async (node: NodeData, ctx: ServiceCtx) => {
  let running = false;
  let stopped = false;
  let pendingRecheck = false;
  let runCount = 0;

  log(`service started at ${node.$path}`);

  async function updateTask(path: string, fields: Record<string, unknown>) {
    const task = await ctx.tree.get(path);
    if (task) await ctx.tree.set({ ...task, ...fields });
  }

  async function updateRunningTasks(paths: string[], output: string) {
    for (const p of paths) {
      const task = await ctx.tree.get(p);
      if (task && task.status === 'running') {
        const { $rev: _, ...rest } = task;
        await ctx.tree.set({ ...rest, log: output });
      }
    }
  }

  // Check if any running tasks have queued inject messages
  async function drainInjected(paths: string[]): Promise<string | null> {
    for (const p of paths) {
      const task = await ctx.tree.get(p);
      const injected = task?.injected as string[] | undefined;
      if (injected?.length) {
        const messages = [...injected];
        await ctx.tree.set({ ...task!, injected: [] });
        return messages.join('\n\n');
      }
    }
    return null;
  }

  async function processInbox() {
    if (running) {
      log('already running, will recheck after');
      pendingRecheck = true;
      return;
    }
    if (stopped) return;

    const tasksPath = `${node.$path}/tasks`;
    const { items } = await ctx.tree.getChildren(tasksPath);
    const tasks = items.filter(t => t.$type === 'metatron.task');
    const pending = tasks.filter(t => t.status === 'pending');
    // Recover tasks stuck in "running" from a previous crash
    const stuck = tasks.filter(t => t.status === 'running');
    for (const t of stuck) {
      log(`  recovering stuck task: ${t.$path} -> pending`);
      await updateTask(t.$path, { status: 'pending', result: '' });
      pending.push(t);
    }

    log(`inbox scan: ${pending.length} pending / ${tasks.length} total tasks`);
    if (!pending.length) return;

    running = true;
    runCount++;
    const runId = runCount;
    log(`run #${runId}: processing ${pending.length} task(s)...`);

    const runningPaths = pending.map(t => t.$path);

    // Mark all pending tasks as "running" with initial progress
    for (const t of pending) {
      log(`  -> running: ${t.$path}`);
      await updateTask(t.$path, { status: 'running', result: 'Waiting for Claude...' });
    }

    try {
      const config = await ctx.tree.get(node.$path) as NodeData;
      const sessionId = config.sessionId as string || '';
      const systemPrompt = config.systemPrompt as string || '';

      const isResume = !!sessionId;
      const skillsSection = isResume ? '' : await loadSkills(ctx, node.$path);
      const taskPrompts = pending.map(t => String(t.prompt || ''));
      const createdBy = (pending[0]?.createdBy as string) ?? null;
      const contextSection = isResume ? '' : await resolveContext(ctx.tree, taskPrompts, createdBy);
      const prompt = isResume ? CHECK_INBOX : (systemPrompt + skillsSection + contextSection) || CHECK_INBOX;
      const permissionRules = await loadPermissions(ctx, node.$path);

      log(`run #${runId}: ${isResume ? 'RESUME session ' + sessionId.slice(0, 8) + '...' : 'NEW session (' + prompt.length + ' chars)'}`);

      // Stream output — debounced progress updates
      let tailBuf = '';
      const progress = debouncedWrite(async () => {
        await updateRunningTasks(runningPaths, tailBuf);
      }, 2000, 'metatron.progress');

      const onOutput = (chunk: string) => {
        tailBuf += chunk;
        progress.trigger();
      };

      let result;
      try {
        result = await invokeClaude(prompt, {
          key: node.$path,
          sessionId: sessionId || undefined,
          model: config.model as string || undefined,
          permissionRules,
          onOutput,
        });
      } catch (sessionErr) {
        if (isResume) {
          const errMsg = sessionErr instanceof Error ? sessionErr.message : String(sessionErr);
          log(`  session resume failed: ${errMsg} — clearing session, retrying fresh`);
          closeSession(node.$path);
          const freshConfig = await ctx.tree.get(node.$path) as NodeData;
          await ctx.tree.set({ ...freshConfig, sessionId: '' });

          tailBuf = '';
          const retrySkills = await loadSkills(ctx, node.$path);
          result = await invokeClaude((systemPrompt + retrySkills) || CHECK_INBOX, {
            key: node.$path,
            model: config.model as string || undefined,
            permissionRules,
            onOutput,
          });
        } else {
          throw sessionErr;
        }
      }

      progress.cancel();

      // Final update on config: session ID + last run
      const fresh = await ctx.tree.get(node.$path) as NodeData;
      await ctx.tree.set({
        ...fresh,
        sessionId: result.sessionId ?? fresh.sessionId,
        lastRun: Date.now(),
      });

      // Task status: aborted → done (with log preserved), error → error, else → done
      const finalStatus = result.aborted ? 'done' : result.error ? 'error' : 'done';
      for (const p of runningPaths) {
        const task = await ctx.tree.get(p);
        if (task) {
          await ctx.tree.set({
            ...task,
            status: finalStatus,
            log: result.output,
            result: result.aborted
              ? (result.text || '[interrupted by user]')
              : (result.text || result.output),
          });
        }
      }

      log(`run #${runId}: ${result.aborted ? 'ABORTED' : 'done'}. session=${result.sessionId?.slice(0, 8) ?? 'none'} cost=$${result.costUsd ?? '?'}`);

      // Check for injected follow-up messages — if found, process them immediately
      if (!result.aborted && result.sessionId) {
        const followUp = await drainInjected(runningPaths);
        if (followUp) {
          log(`run #${runId}: processing injected follow-up`);
          running = false; // allow re-entry
          // Re-set tasks to running for the follow-up
          for (const p of runningPaths) {
            await updateTask(p, { status: 'running', result: 'Processing follow-up...' });
          }
          // Recursive process with pending tasks will pick them up
          pendingRecheck = true;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`run #${runId}: FAILED — ${msg}`);

      // Revert running tasks back to pending so they can be retried
      for (const p of runningPaths) {
        const current = await ctx.tree.get(p);
        if (current && current.status === 'running') {
          log(`  -> reverting to pending: ${p}`);
          await ctx.tree.set({ ...current, status: 'pending', result: `Error: ${msg}` });
        }
      }

      const fresh = await ctx.tree.get(node.$path) as NodeData;
      await ctx.tree.set({
        ...fresh,
        lastRun: Date.now(),
      });
    } finally {
      running = false;
    }

    if (!stopped && pendingRecheck) {
      pendingRecheck = false;
      log('recheck triggered (new tasks arrived during run)');
      processInbox();
    }
  }

  const unsub = ctx.subscribe(`${node.$path}/tasks`, (event) => {
    log(`event: ${event.type} ${event.path}`);
    if (event.type === 'set' || event.type === 'patch') {
      processInbox();
    }
  }, { children: true });

  // Initial inbox check on startup
  log('initial inbox check...');
  processInbox();

  return {
    stop: async () => {
      log('service stopping');
      stopped = true;
      unsub();
      closeSession(node.$path);
      log('service stopped');
    },
  };
});
