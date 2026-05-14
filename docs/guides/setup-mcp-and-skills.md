---
title: Setup MCP and Skills
section: guides
order: 10
description: Connect Treenix MCP to Codex and Claude, and install Treenix skills
tags: [guide, ai, agents, mcp]
---

# Setup MCP and Skills

## Start Treenix

```bash
npm run dev
```

MCP endpoint:

```text
http://127.0.0.1:3211/mcp
```

Dev mode allows unauthenticated loopback MCP calls. Do not expose this port publicly.

## Codex

Install Treenix skills:

```text
npx skills@latest add treenix-io/treenix \
  --skill treenix \
  --skill treenix-mod-creator \
  --skill treenix-view-builder \
  --agent codex \
  --global \
  --yes
```

Restart Codex.

Add MCP to `~/.codex/config.toml`:

```toml
[mcp_servers.treenix]
url = "http://127.0.0.1:3211/mcp"
```

Restart Codex again after editing the config.

## Claude Code

Install Treenix skills:

```bash
npx skills@latest add treenix-io/treenix \
  --skill treenix \
  --skill treenix-mod-creator \
  --skill treenix-view-builder \
  --agent claude-code \
  --global \
  --yes
```

Available skills: `/treenix`, `/treenix-mod-creator`, `/treenix-view-builder`.

Connect MCP:

```bash
claude mcp add --transport http treenix http://127.0.0.1:3211/mcp
claude mcp list
```

Inside Claude Code, run `/mcp` to inspect the connection.

## Claude App

For Claude web or Desktop skills, open **Customize -> Skills -> +** and paste each skill URL:

```text
https://github.com/treenix-io/treenix/tree/main/skills/treenix
https://github.com/treenix-io/treenix/tree/main/skills/treenix-mod-creator
https://github.com/treenix-io/treenix/tree/main/skills/treenix-view-builder
```

Toggle the added skills on.

For Claude Desktop MCP, open **Settings -> Developer -> Edit Config** and add:

```json
{
  "mcpServers": {
    "treenix": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote@latest",
        "http://127.0.0.1:3211/mcp",
        "--allow-http",
        "--transport",
        "http-first"
      ]
    }
  }
}
```

Restart Claude Desktop.

Do not use `http://127.0.0.1:3211/mcp` as a claude.ai web connector. Web connectors must be reachable from Anthropic's cloud; localhost only works through local clients.

## Verify

Ask the client to inspect the Treenix MCP catalog. A working connection exposes `catalog`, `describe_type`, `search_types`, and tools generated from registered Type methods.
