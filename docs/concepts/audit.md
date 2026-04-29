---
title: Audit Trail
section: concepts
order: 9
description: Every mutation is a typed event — who, when, what, through where
tags: [core, security, observability]
---

# Audit Trail

Every mutation is a typed event: who, when, what, through where. Time-travel replay and journaled semantics across the whole [Tree](./tree.md). Same path for [agents](./ai-mcp.md) — their writes land in the same log.

```typescript
$lineage: {
  by:     'agent:weekly-summarizer',
  at:     '2026-04-17T09:12:03Z',
  action: 'setTitle',
  via:    'flow:delivery-friday',
  origin: 'https://acme-crm.com/tickets/42',
}
```

Every change is tagged with who did it and where it came from — queryable, revertible, exportable as a log. You don't enable auditing per call; it's the default path every write takes.

## The lineage fields

| Field | Meaning | Example |
|---|---|---|
| `by` | The caller identity | `user:alice`, `agent:weekly-summarizer`, `service:billing-cron` |
| `at` | ISO timestamp of the commit | `'2026-04-17T09:12:03Z'` |
| `action` | The action method invoked | `setTitle`, `complete`, `advance` |
| `via` | The workflow, flow, or pipeline that produced the call | `flow:delivery-friday`, `cli:ingest` |
| `origin` | Upstream source that triggered the chain | `https://acme-crm.com/tickets/42` |

`by`, `at`, `action` are always populated. `via` and `origin` are set when the caller provides them — flows and integrations stamp them automatically; direct user actions usually leave them blank.

## Where lineage comes from

The write pipeline stamps lineage during the persist step — after [ACL](./security.md#acl) and [Validation](./security.md#validation), before broadcast. You don't write lineage manually; it's produced by the engine as every mutation walks [the pipeline](./types.md#storage).

That means:

- **Agents can't forge lineage.** Their calls go through the same pipeline as humans. The server names them; they don't name themselves.
- **Services inherit identity.** When a service calls an action inside a triggered flow, `by` reflects the service account and `via` reflects the flow.
- **Cross-instance writes keep origin.** When a write arrives over [federation](./roadmap.md#federation) or [mounts](./mounts.md), `origin` records the source.

## Agent writes are the same writes

This matters because it's the hard part. Most systems run AI through a separate tool pipeline, with its own log, its own rate limits, its own bugs. In Treenix, an agent calling a method on a registered [Type](./types.md) is indistinguishable from a human calling that same method — both produce the same event, the same patch, the same lineage row.

```
$lineage: { by: 'user:leo',                    action: 'assign', ... }
$lineage: { by: 'agent:triage', via: 'flow:inbox', action: 'assign', ... }
```

Filtering for agent writes is a query over `by`, not a separate table.

## Consuming the trail

Every [Reactivity](./reactivity.md) patch carries enough context to rebuild history. Common uses:

- **Feed:** subscribe to a path with `{ children: true }` and render the stream as an activity timeline.
- **Replay:** iterate historical patches for a path to reconstruct a node's state at any point.
- **Alerts:** a [service](./context.md#services) subscribes to writes under `/finance/*`, flags `by: 'agent:*'` with `action: 'transfer'` for review.
- **Export:** dump lineage to cold storage for compliance, separate from operational data.

The shape is open — nothing stops you from treating `$lineage` as just another field. Queries via [getChildren](./tree.md) filter on it exactly like any other field.

## Related

- [Type → Storage pipeline](./types.md#storage) — where lineage is stamped
- [Security](./security.md) — ACL and Validation that every audited write passes
- [AI / MCP](./ai-mcp.md) — why agent writes land in this same log
- [Reactivity](./reactivity.md) — the patch stream that carries lineage
- Guide: [Secure an App](../guides/security.md) — auditing patterns in practice
