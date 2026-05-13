---
name: treenix
description: Work with Treenix through its MCP tree tools. Use when the user writes `/treenix` or `$treenix`, asks to inspect/check Treenix tasks or Kanban boards, asks what should be worked on in MCP, asks to build/configure something in Treenix, or references Treenix nodes, modules, board.task cards, `/demo-board`, `/demo-video`, or the Treenix tree. This skill guides discovery through catalog/schema first, safe exploration of tree nodes, and status changes through Treenix actions.
---

# Treenix

## Operating Rule

Treat Treenix as a live tree you can inspect and mutate through MCP. Do not guess structure from names or UI labels: discover nodes, read real paths, inspect type schemas, then execute actions or writes.

If Treenix MCP tools are not available in the current session, say that clearly. If a tool loader/search tool is available, use it to load Treenix MCP before giving up. Do not claim a Treenix state was checked unless it was read through MCP.

## Discovery Workflow

1. Get the Treenix type/module catalog first for build or mutation work.
2. Use `describe_type` before calling unfamiliar actions or writing unfamiliar components.
3. Use `get_node` for the exact node before mutation.
4. Use `list_children(..., full: true)` when reading boards, mounted columns, or child tasks so `$path` is visible.
5. Prefer schema-backed Treenix actions over direct writes when actions exist.

Common MCP operations:

- `catalog`: list registered Treenix types/modules and actions.
- `describe_type`: inspect fields and action arguments for a type.
- `get_node`: read one full node by real path.
- `list_children`: inspect children; use `full: true` for actionable paths.
- `execute`: invoke an action on a node/component.
- `set_node`: create or update a node.

## Creating Or Updating Nodes

`set_node` accepts only these tool args: `path`, `type`, `components?`, `acl?`, `owner?`. To pass primary-component data you wrap it under `components` with a `$type` that matches the outer `type` — MCP then **flattens those fields onto the node**, so the stored shape is node-level (matching the `treenix-mod-creator` canon).

Wire format you send:

```json
{
  "path": "/demo-board/data/example-task",
  "type": "board.task",
  "components": {
    "task": {
      "$type": "board.task",
      "title": "Example task",
      "status": "todo",
      "priority": "normal"
    }
  }
}
```

Stored node after MCP unwraps it:

```json
{
  "$path": "/demo-board/data/example-task",
  "$type": "board.task",
  "title": "Example task",
  "status": "todo",
  "priority": "normal"
}
```

Fields live at the **node level**, not nested under `task`. Entries inside `components` whose `$type` does **not** match the outer `type` are kept as **additional components** under that key (e.g. `components: { chat: { $type: "metatron.chat" } }`).

## Building With Treenix

When the user wants to build something in Treenix:

- First get the mods/type catalog.
- Identify the relevant types and actions before creating nodes.
- Prefer Treenix-native modules, prefabs, and actions over ad hoc filesystem work.
- If a prefab or module action exists, inspect its schema and use it rather than manually recreating its output.
- Mutate only after reading the real target node and schema.
