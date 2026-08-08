// mount.ts registration contract: importing the module wires mongo.collection into the registry.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolve } from '@treenx/core';

import './mount';

describe('mongo.collection mount registration', () => {
  it('registers the mount adapter and the schema', () => {
    assert.ok(resolve('mongo.collection', 'mount'), 'mount adapter registered');
    assert.ok(resolve('mongo.collection', 'schema'), 'JSON schema registered');
  });
});
