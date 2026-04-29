---
title: Self-Hosting Checklist
section: platform
order: 4
description: Env vars, secrets, backups, upgrade path
tags: [platform, operations, production]
---

# Self-Hosting Checklist

This page is a pragmatic list — what to set, what to back up, what to check before and after going live. For setup instructions see [Deployment](./deployment.md); for storage trade-offs see [Storage Adapters](./storage-adapters.md).

## Before first deploy

- [ ] **`root.json` is production-shaped.** No dev shortcuts, realistic `$acl` on root, correct [mount](../concepts/mounts.md) topology. See [Deployment → root.json](./deployment.md).
- [ ] **Schemas current.** `schemas/*.json` files regenerate when the server boots. In CI, boot the server once against a throwaway store before running schema-dependent checks.
- [ ] **No `VITE_DEV_LOGIN=1` in the production environment.** That flag bypasses the login screen — leaving it on is a wide-open door.
- [ ] **Node version matches starter.** Node 22+.
- [ ] **Database reachable from the container.** Run a health check against Mongo/the configured store before starting the app.
- [ ] **Reverse proxy terminates TLS.** Treenix speaks plain HTTP; certificate management belongs at the proxy.
- [ ] **Health check wired.** The container runtime (Docker Compose / Kubernetes / Fly) probes `GET /trpc/get?input=...` — see [Deployment → Health checks](./deployment.md).

## Environment variables

Set the ones your topology needs. See [CLI Reference → Environment variables](./cli.md) for the full list.

| Variable | Required when | Notes |
|---|---|---|
| `MONGO_URI` | Using `t.mount.mongo` without an explicit `uri` in `root.json` | Connection string incl. auth |
| `DOCS_ROOT` | You've overridden the docs mount target | Absolute path |
| `CLAUDE_MEMORY_DIR` | MCP agent memory isn't at the default location | Writeable directory |
| `TREENIX_STARTER_URL` | `create-treenix` should fetch from a private mirror | `http(s)://` or `file://` |

Secrets belong in the orchestrator's secret store (Docker secrets, Kubernetes Secret, env files out of git). Never commit a `.env` to source control and never read `.env` files from application code.

## Backups

Back up what your mount topology persists.

| Mount | What to back up | How |
|---|---|---|
| `t.mount.fs` (below `tree/seed/`) | Git repo | Routine git |
| `t.mount.fs` (`tree/work/`) | Directory | Periodic `tar` / `rsync` / object-store sync |
| `t.mount.mongo` | Mongo database | `mongodump`, Atlas backup, or replica-set snapshots |
| `t.mount.memory` | — | Nothing to back up; volatile by design |

Test restore, not just backup. A `mongodump` you've never `mongorestore`'d is an untested promise.

## Upgrades

Treenix ships through the starter repo + npm packages. An upgrade is:

1. `git pull` (or update the `@treenx/*` versions in `package.json`).
2. `npm install`.
3. Review new or changed [Types](../concepts/types.md) — if a mod's schema changed, existing nodes may need migration.
4. Deploy. Schemas regenerate on the next server boot.

Treenix does not auto-migrate stored nodes. Adding new optional fields is safe; renaming, removing, or narrowing existing fields requires a migration script you write (read nodes, transform, write back through `tree.set`).

## Observability

First-party observability is modest; most operators lean on their host platform.

- **Logs.** The server writes structured logs to stdout. Route them through your log aggregator.
- **Health.** Wire the `/trpc/get?input={"path":"/"}` probe as liveness.
- **Agent activity.** Every [agent write carries lineage](../concepts/audit.md). Query `$lineage.by` starting with `agent:` to build an activity feed.
- **Subscription health.** The SSE stream is the critical path for realtime — monitor client reconnect rates if users report "it's not updating."

## Multi-tenant operations

The operational shape most Treenix SaaS deploys use:

- **One image, many containers.** Container per tenant, each with its own `root.json`.
- **One Mongo, DB per tenant.** Namespaced (`treenix_${tenant}`), backed up uniformly.
- **Shared reverse proxy.** Subdomain or path per tenant, routed to the right container.
- **Admin bootstrap.** The first registered user of a fresh tenant is promoted to the `admins` group — everyone else defaults to `pending` until an admin activates them.

Automating tenant creation (new Mongo DB, new container, new proxy route) is your integration glue.

## Related

- [Deployment](./deployment.md) — Docker, reverse proxy, TLS
- [CLI Reference](./cli.md) — environment variables in detail
- [Storage Adapters](./storage-adapters.md) — backup strategies per adapter
- [Security → ACL](../concepts/security.md#acl) — the `$acl` that protects production
- [Audit Trail](../concepts/audit.md) — `$lineage` as the paper trail
