import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { describe, it } from 'node:test'

import { coverage } from './coverage'

const numbered = (prefix: string, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`)

// Pinned against axioms.md: a dropped or renamed row fails here instead of leaving the gate unnoticed.
const DEFINITIONS = ['D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'D11', 'D12', 'D13']
const AXIOMS = numbered('A', 0, 10)
const THEOREMS = numbered('T', 1, 14)

const INCIDENTS = [
  'incident: a user mount of fs, mongo or trpc read the server disk and opened SSRF',
  'incident: a list filter was an oracle over hidden fields',
  'incident: $acl and $owner reached readers without A in events',
  'incident: a hidden node answered forbidden, an absent one not found',
  'incident: the account owner saw the password hash',
  'incident: with / mounted, deletions went to an in-memory trash and were lost on restart',
  'incident: trash collection deleted live tasks through a query mount',
  'incident: an anonymous call started a service with system rights',
  'incident: MCP ignored the narrowed agent scope',
  'incident: sessions kept working after the account was blocked',
  'incident: snapshot and event races — registration inside the read, ordering on the client',
  "incident: a public form's anonymous W on the subscriber folder deleted others' entries",
  'incident: a client chose the $id of a new node',
  "incident: the type ACL skipped the node's main type",
]

describe('kernel contract coverage', () => {
  it('has one row per normative item and Appendix A incident, and no other', () => {
    assert.deepEqual(Object.keys(coverage).sort(), [...DEFINITIONS, ...AXIOMS, ...THEOREMS, ...INCIDENTS].sort())
  })

  it('every row is pending or names an existing test file in this directory', () => {
    for (const [item, test] of Object.entries(coverage)) {
      const proven = test !== 'pending' && !test.includes('/') && existsSync(new URL(test, import.meta.url))
      assert.ok(test === 'pending' || proven, `${item}: ${test}`)
    }
  })
})
