# create-treenix

**Scaffold a Treenix project in seconds.**

## Usage

### Try it without committing

```bash
npx -y create-treenix start
```

Downloads the starter into a cached playground, installs deps once, starts the dev server. Re-run to jump back in; `--reset` wipes and re-downloads.

### Scaffold a named project

```bash
npx -y create-treenix my-app
```

Downloads the starter into `./my-app`, installs deps, tells you how to run it. Add `-y` to skip prompts.

### Add a mod to an existing project

```bash
npx -y create-treenix mod create my-mod
```

Must be run inside a Treenix project (walks up to find `root.json`). Creates `types.ts`, `view.tsx`, `seed.ts`; registers the seed in `root.json`.

## What you get

Whatever `github.com/treenix-io/starter` contains at `main`. Currently:

- Vite 8 frontend on `:3210`, Treenix server on `:3211` (single process).
- Admin UI (tree browser, node editor, context-aware views) auto-loaded from `@treenx/mods` and `@treenx/react`.
- `root.json` with FS overlay (`tree/seed` + `tree/work`).
- `mods/example` and `mods/profile` — edit or delete.

```
my-app/
├── tree/seed/       seed tree (checked in)
├── tree/work/       runtime overlay (gitignored)
├── mods/            your mods
├── src/main.tsx     `import '@treenx/react/main'`
├── root.json        server config
├── vite.config.ts   Vite + Treenix plugin
└── package.json
```

Open `http://localhost:3210` — you'll see the admin UI.

## Under the hood

The CLI fetches a tarball from GitHub and extracts it — no git, no submodules. The starter repo is the single source of truth; updates to it ship immediately without republishing this CLI.

## License

FSL-1.1-MIT.
