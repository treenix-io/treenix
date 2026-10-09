import { registerType } from '@treenx/core/comp';
import { register } from '@treenx/core';
import { registerKernel, registerKernelAction } from '@treenx/core/kernel';
import type { TypeSchema } from '@treenx/core/schema/types';
import { nativeIdealService } from './native-service';
import type { Idea } from './types';
import boardSchemaJson from './schemas/ideal.board.json';
import ideaSchemaJson from './schemas/ideal.idea.json';

const boardSchema: TypeSchema = { ...boardSchemaJson, type: 'object' };
const ideaSchema: TypeSchema = { ...ideaSchemaJson, type: 'object' };

class IdealBoardType {}
class IdealIdeaType {}

/** Registers the ideal schemas, ordinary idea actions, and board service. */
export function registerNativeIdeal(): void {
  registerType('ideal.board', IdealBoardType, { security: 'user-capability' });
  registerType('ideal.idea', IdealIdeaType);
  register('ideal.board', 'schema', () => boardSchema);
  register('ideal.idea', 'schema', () => ideaSchema);
  registerKernel('ideal.board', 'service', nativeIdealService);
  registerKernelAction('ideal.idea', 'upvote', {
    kind: 'write',
    args: {},
    handler: nativeUpvote,
  });
  registerKernelAction('ideal.idea', 'approve', {
    kind: 'write',
    args: {},
    handler: nativeApprove,
  });
  registerKernelAction('ideal.idea', 'reject', {
    kind: 'write',
    args: {},
    handler: nativeReject,
  });
}

/** Applies the existing caller-authorized vote transition. */
async function nativeUpvote(this: Idea): Promise<void> {
  this.votes++;
}

/** Applies the existing caller-authorized approval transition. */
async function nativeApprove(this: Idea): Promise<void> {
  this.status = 'approved';
}

/** Applies the existing caller-authorized rejection transition. */
async function nativeReject(this: Idea): Promise<void> {
  this.status = 'rejected';
}
