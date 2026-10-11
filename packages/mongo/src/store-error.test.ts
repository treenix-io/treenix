import assert from 'node:assert/strict';
import { it } from 'node:test';
import { BSON, Int32, MongoServerError } from 'mongodb';
import { KernelError } from '@treenx/core/errors';
import { databaseError } from '#store';

it('maps native numeric and preserved BSON error codes to kernel outcomes', () => {
  for (const [received, expected] of [[50, 'BUDGET'], [11000, 'CONFLICT']] as const) {
    for (const code of [received, new Int32(received)]) {
      const reply = BSON.deserialize(BSON.serialize({ code }), { promoteValues: false });
      assert.throws(() => databaseError(new MongoServerError(reply)),
        error => error instanceof KernelError && error.code === expected);
    }
    assert.throws(() => databaseError(new MongoServerError({ code: received })),
      error => error instanceof KernelError && error.code === expected);
  }
});
