---
title: Deployment
section: platform
order: 2
description: Docker, root.json, MongoDB, reverse proxy, TLS
tags: [platform, deployment, production]
---

# Deployment

A Treenix project is a normal Node service. Any hosting that runs Node and can reach your database works — serverless platforms, Docker Compose, Kubernetes, Fly, Railway, a single VPS.

This page covers the shape of the configuration and a minimal Docker deploy. Production tuning, backups, and secrets live in [Self-Hosting Checklist](./self-hosting.md).

## `root.json` — the server's storage map

The server reads its startup topology from `root.json`. It declares the root node, default [ACL](../concepts/security.md#acl), which seed prefabs deploy, and the [mount](../concepts/mounts.md) tree that backs storage.

```json
{
  "$path": "/",
  "$type": "metatron.config",
  "$acl": [
    { "g": "public", "p": 1 },
    { "g": "authenticated", "p": 9 },
    { "g": "admins", "p": 15 }
  ],
  "seeds": ["core"],
  "mount": { "$type": "t.mount.overlay", "layers": ["base", "work"] },
  "base":  { "$type": "t.mount.fs", "root": "tree/seed" },
  "work":  { "$type": "t.mount.fs", "root": "tree/work" }
}
```

| Field | Purpose |
|---|---|
| `$acl` | Root-level permissions. Inherited by every node without its own ACL. |
| `seeds` | Which seed prefabs to deploy on startup. `"core"` = system nodes. |
| `mount` | Root storage — overlay, single adapter, or complex topology. |

The default is filesystem-backed overlay: `tree/seed/` (seed, git-tracked) below, `tree/work/` (runtime writes, gitignored) above.

## MongoDB in production

Swap the work layer for MongoDB. Seed data stays in git; runtime state persists in Mongo:

```json
{
  "$path": "/",
  "$type": "metatron.config",
  "$acl": [
    { "g": "public", "p": 1 },
    { "g": "authenticated", "p": 9 },
    { "g": "admins", "p": 15 }
  ],
  "seeds": ["core"],
  "mount": { "$type": "t.mount.overlay", "layers": ["base", "work"] },
  "base":  { "$type": "t.mount.fs", "root": "tree/seed" },
  "work": {
    "$type": "t.mount.mongo",
    "uri": "mongodb://localhost:27017",
    "db": "treenix",
    "collection": "nodes"
  }
}
```

For pure MongoDB (no filesystem seed), replace `mount` with a single `t.mount.mongo`. See [Storage Adapters](./storage-adapters.md) for trade-offs.

System fields (`$path`, `$type`, `$acl`) are stored as `_path`, `_type`, `_acl` in MongoDB — the `$` prefix collides with Mongo operators. The conversion is transparent to application code.

## Docker

Minimal production image. Uses `tsx` at runtime to run TypeScript directly; do not strip devDependencies.

```dockerfile
FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .

EXPOSE 3211

CMD ["npx", "tsx", "engine/core/src/server/main.ts", "root.json"]
```

`npm ci` (not `--production`) is required — `tsx` is a devDependency used at runtime. Schemas regenerate on server startup; no separate build step.

```yaml
# docker-compose.yml
services:
  treenix:
    build: .
    ports:
      - "3211:3211"
    depends_on:
      - mongo

  mongo:
    image: mongo:7
    volumes:
      - mongo-data:/data/db

volumes:
  mongo-data:
```

For the frontend, either bundle it into the same image (Vite `build` + static serve) or deploy it separately behind the same domain.

## Reverse proxy + TLS

Any HTTP proxy works (Traefik, nginx, Caddy). The server speaks plain HTTP on `3211` — terminate TLS at the proxy, forward `/trpc` and `/api` to the backend, serve static frontend from the build output.

Minimal nginx:

```nginx
server {
  listen 443 ssl http2;
  server_name app.example.com;

  # ... TLS config ...

  location /trpc/ { proxy_pass http://127.0.0.1:3211; }
  location /api/  { proxy_pass http://127.0.0.1:3211; }
  location /      { root /var/www/app-frontend; try_files $uri /index.html; }
}
```

## Ports

| Port | Service | Configurable via |
|---|---|---|
| 3210 | Frontend (Vite dev) | `vite.config.ts` |
| 3211 | Backend (tRPC + SSE) | Server startup args |
| 3212 | MCP server | Server startup args |

In development, the Vite plugin proxies `/trpc` and `/api` from 3210 → 3211 so you only ever open `3210`. In production, the reverse proxy does the same.

## Health checks

The server exposes a tRPC endpoint. A minimum health check:

```bash
curl 'http://localhost:3211/trpc/get?input=%7B%22path%22%3A%22%2F%22%7D'
```

Returns the root node if the server is running and the tree is reachable. Add this as the liveness probe in compose / Kubernetes.

## Multi-tenant deployments

Each tenant is its own project root — separate `root.json`, separate Mongo database (or namespaced collection), separate container. The common pattern:

- One image, many containers — `treenix-${tenant}` — each with its own `root.json`.
- One MongoDB, one database per tenant (`treenix_${tenant}`) — cheaper than separate instances, still isolated.
- A shared proxy routes tenant subdomains to the right container.

This is the operational shape of every Treenix SaaS deploy we're aware of. Automating it is your integration glue — there's no first-party multi-tenant CLI.

## Related

- [Quickstart & Setup](../getting-started/installation.md) — development setup
- [Project Structure](../getting-started/project-structure.md) — what lives in the project
- [Mounts](../concepts/mounts.md) — all the ways storage composes
- [Storage Adapters](./storage-adapters.md) — memory / fs / mongo trade-offs
- [Self-Hosting Checklist](./self-hosting.md) — env, secrets, backups, upgrades
- [Security → ACL](../concepts/security.md#acl) — root-level permissions
- [CLI Reference](./cli.md) — `create-treenix`, `treenix`, env vars
