// /branches root — branches are created via the `create` action on it.
// Two-layer isolation model: ACL is coarse (agents may write only under
// /branches — root grant drops to R+S in S3), capability narrows a workload
// session to ITS branch (writePaths=['/branches/<id>/**']). Per-branch nodes
// additionally grant `u:<owner>` full bits at create time.

import { A, R, S, W } from '@treenx/core';
import { registerPrefab } from '@treenx/core/mod';

registerPrefab('branch', 'seed', [
  {
    $path: 'branches',
    $type: 't.branches',
    $acl: [
      { g: 'admins', p: R | W | A | S },
      { g: 'agents', p: R | W | A | S },
    ],
  },
]);
