import { nativeSchemaModule } from '#native-module';
import type { ModuleManifest } from '@treenx/core/kernel/types';
import type { TypeSchema } from '@treenx/core/schema/types';
import { nativeIdealService } from './native-service';
import type { Idea } from './types';
import boardSchemaJson from './schemas/ideal.board.json';
import ideaSchemaJson from './schemas/ideal.idea.json';

const boardSchema: TypeSchema = { ...boardSchemaJson, type: 'object' };
const ideaSchema: TypeSchema = { ...ideaSchemaJson, type: 'object' };

class IdealBoardType {}
class IdealIdeaType {}

/** Own the ideal schemas, ordinary idea actions, and board service. */
export function nativeIdealManifest(): ModuleManifest {
  return nativeSchemaModule(
    '@treenx/mods/ideal',
    [
      { name: 'ideal.board', security: 'user-capability', schema: boardSchema, methods: [] },
      {
        name: 'ideal.idea',
        security: 'ordinary',
        schema: ideaSchema,
        methods: [],
        actions: {
          upvote: {
            kind: 'write',
            args: {},
            handler: nativeUpvote,
          },
          approve: {
            kind: 'write',
            args: {},
            handler: nativeApprove,
          },
          reject: {
            kind: 'write',
            args: {},
            handler: nativeReject,
          },
        },
      },
    ],
    [{ type: 'ideal.board', context: 'service', handler: nativeIdealService }],
    [
      {
        type: 'ideal.board',
        context: 'class',
        handler: { handler: IdealBoardType, meta: { security: 'user-capability' } },
      },
      { type: 'ideal.idea', context: 'class', handler: IdealIdeaType },
    ],
  );
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
