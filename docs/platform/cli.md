---
title: CLI Reference
section: platform
order: 1
description: create-treenix and treenix — commands, flags, environment variables
tags: [platform, cli]
---

# CLI Reference

Two npm-shipped CLIs cover the project lifecycle:

- **`create-treenix`** — scaffold a project, add mods, run an ephemeral playground.
- **`treenix`** — alternative runner that clones the starter via git and runs `root.json` directly.

Both are invoked via `npx` (no global install needed). The copy-paste examples use `npx -y` so npm does not stop to ask before installing the CLI package.

## create-treenix

### `create-treenix [name] [-y|--yes]`

Create a new Treenix project.

```bash
npx -y create-treenix my-app
```

Downloads the latest `treenix-io/starter`, rewrites `package.json` name, installs dependencies with the detected package manager (npm / pnpm / bun).

| Flag | Description |
|---|---|
| `[name]` | Project directory name. Prompted interactively if omitted. |
| `-y`, `--yes` | Skip prompts — accepts defaults. |

### `create-treenix start [--reset]`

Spin up an ephemeral playground in `~/.cache/treenix/play`. Useful for quick experiments without creating a project.

```bash
npx -y create-treenix start
# → downloads starter once into ~/.cache/treenix/play
# → installs deps once
# → runs npm run dev

npx -y create-treenix start --reset   # wipe the cache first
```

| Flag | Description |
|---|---|
| `--reset` | Wipe the cached playground before starting. |

### `create-treenix mod create <name> [-y|--yes]`

Scaffold a new [mod](../guides/create-a-mod.md) directory under `mods/<name>/` in the current project. The current CLI generates `types.ts`, `view.tsx`, and `seed.ts`, then registers the seed in `root.json`.

```bash
npx -y create-treenix mod create todo
npx -y create-treenix mod create todo -y    # no prompts
```

## treenix

### `treenix init [name]`

Alternative way to create a project — uses `git clone --recurse-submodules` to pull `treenix-io/starter` directly from GitHub. `.git` is removed afterwards so you start with a clean repo.

```bash
npx treenix init my-app
```

| Argument | Description |
|---|---|
| `[name]` | Project directory name. Defaults to `my-treenix-app`. |

### `treenix` (no args)

Run a server from `root.json` in the current directory. Looks for `engine/core/src/server/main.ts` as the entry point and spawns it under `tsx --watch`.

```bash
cd my-app
npx treenix
```

The newer starter uses `npm run dev` (Vite plugin hosts the server inside the dev process). `treenix` is useful when you want the server without the frontend — e.g., in a Docker container serving an already-built frontend.

## Environment variables

These variables are read by the CLIs or the server at startup.

| Variable | Used by | Purpose |
|---|---|---|
| `TREENIX_STARTER_URL` | `create-treenix` | Override the starter tarball URL. Accepts `http(s)://` or `file://`. |
| `DOCS_ROOT` | Server | Override the directory the `doc/seed` prefab mounts at `/docs`. |
| `CLAUDE_MEMORY_DIR` | Server (MCP) | Location of persistent agent memory. |
| `MONGO_URI` | Server (when using `t.mount.mongo`) | MongoDB connection string. |
| `VITE_DEV_LOGIN` | Frontend dev | When `1`, skips the login screen in the dev environment. |

See [Self-Hosting Checklist](./self-hosting.md) for the full production checklist.

## npm scripts in a starter project

The generated starter ships with one script you run often:

```bash
npm run dev       # Start the app — Vite serves frontend + hosts Treenix server
```

Additional scripts depend on the starter version; run `npm run` inside the project to list them.

## Related

- [Quickstart & Setup](../getting-started/installation.md) — zero to running in five minutes
- [Project Structure](../getting-started/project-structure.md) — what's in a starter
- [Deployment](./deployment.md) — Docker, reverse proxy, TLS
- [Self-Hosting Checklist](./self-hosting.md) — env vars, secrets, backups
- [Build a Mod](../guides/create-a-mod.md) — what `create-treenix mod create` scaffolds
