// /branches root — branches are created via the `create` action on it.
// Two-layer isolation model: ACL is coarse (agents may write only under
// /branches — root grant drops to R+S in S3), capability narrows a workload
// session to ITS branch (writePaths=['/branches/<id>/**']). Per-branch nodes
// additionally grant `u:<owner>` full bits at create time.

import { A, makeNode, R, S, W } from '@treenx/core';
import { registerPrefab } from '@treenx/core/mod';

// The description is THE onboarding text for agents: prompt composers inject
// it at run start and ad-hoc agents discover it by reading /branches via MCP.
// Editing this node changes agent onboarding live — no deploy.
const WORKFLOW = `Branches are write-isolated workspaces over the live tree.
The live tree is read-only for agents; changes reach live only through a human-reviewed merge.

Workflow:
1. create: execute('/branches', 'create', { title }) -> { path }. Orchestrated runs get a branch automatically.
2. work: write under <branch>/tree/... — reads fall through to live, writes are captured in the branch.
   In a branch-rooted session '/' IS your branch view and /.branch is your branch control node.
3. inspect: execute 'diff' on the branch (or /.branch) to list your changes.
4. finish: execute 'requestMerge' with a note — flips the branch to review; a human reviews the diff and merges.
   Watch status and conflicts on the branch node.`;

const branchesRoot = makeNode('branches', 't.branches', {}, {
  description: { $type: 't.description', text: WORKFLOW },
});
branchesRoot.$acl = [
  { g: 'admins', p: R | W | A | S },
  { g: 'agents', p: R | W | A | S },
];

registerPrefab('branch', 'seed', [branchesRoot]);
