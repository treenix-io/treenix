# create-treenity

**Scaffold a new Treenity project in seconds.**

## Usage

```bash
npx create-treenity my-app
```

Interactive prompts will guide you through setup. Or skip prompts:

```bash
npx create-treenity my-app -y
```

## What You Get

```
my-app/
├── mods/
│   └── todo/          example mod (type + actions + React view)
├── data/              seed data
├── root.json          server config
├── package.json
└── tsconfig.json
```

A working Treenity project with:
- **Server** with memory store, tRPC, and MCP
- **Frontend** with React, Tailwind CSS v4, admin UI
- **Example mod** showing the type → action → view pattern

## Development

```bash
cd my-app
npm run dev:server   # start backend (port 3211)
npm run dev:front    # start frontend (port 3210)
```

Open `http://localhost:3210` — you'll see the admin UI with your example mod running.

## Next Steps

Create a new mod:

```
mods/
└── my-mod/
    ├── types.ts     # type class (fields = schema, methods = actions)
    ├── server.ts    # server entry (imports types, registers services)
    └── client.ts    # client entry (imports types, registers React views)
```

See the [Getting Started guide](https://github.com/treenity-ai/treenity/blob/main/docs/getting-started.md) for a full walkthrough.

## License

Licensed under FSL-1.1-MIT. Free to use for any purpose. Converts to MIT automatically after two years from each release date.
