---
title: Documenting Types
section: guides
order: 8
description: JSDoc annotations for Inspector forms, MCP discovery, and AI tools
tags: [guide, intermediate]
---

# Documenting Types

JSDoc annotations on type classes power three things:

1. **Inspector** — renders labeled forms with appropriate widgets
2. **MCP tools** — `catalog`, `describe_type`, `search_types` show descriptions to AI
3. **JSON Schema** — runtime validation of component data

Without annotations, the Inspector shows raw JSON textareas. With them, it shows typed forms with labels, descriptions, and specialized widgets.

## Annotating a Class

```typescript
/** Hero banner — full-width section with title, image, and call-to-action */
export class BlockHero {
  /** @title Title @description Main heading for the page */
  title = ''

  /** @title Background image @format image */
  image = ''

  /** @title Button text */
  cta = 'Learn more'

  /** @description Update the banner content */
  update(data: { title: string; image: string; cta: string }) {
    this.title = data.title
    this.image = data.image
    this.cta = data.cta
  }
}

registerType('block.hero', BlockHero)
```

The first line of the class JSDoc becomes the type's title and description in the catalog.

## Tag Reference

| Tag | Where | What it does |
|-----|-------|-------------|
| First line | Class | Type title — shown in catalog, Inspector header |
| `@title` | Field | Form label in Inspector |
| `@description` | Field/Method | Tooltip (fields) or action description (methods) |
| `@format` | Field | Widget type (see below) |
| `@refType` | Field | Link to another type (auto-detected for class-typed fields) |
| `@pre` | Method | Fields the action reads — dependency declaration |
| `@post` | Method | Fields the action writes — output declaration |

## Format Widgets

| Format | Widget | Use for |
|--------|--------|---------|
| `image` | URL input + image preview | Image URLs |
| `textarea` | Multiline text editor | Long text, JSON, descriptions |
| `uri` | URL input + clickable link | External links |
| `email` | Email input | Email addresses |
| `path` | Node path input | Treenix paths (auto with `@refType`) |
| `tags` | Chips with add/remove | String arrays |
| `tstring` | Multilingual editor | Translation objects `{ en: "...", ru: "..." }` |
| `timestamp` | Formatted date display | Unix timestamps |

Without `@format`, fields render by their TypeScript type: `string` → text input, `number` → number input, `boolean` → checkbox.

## Methods

Methods become actions. Annotate with `@description` for AI discoverability:

```typescript
/** Kitchen order — tracks items through preparation stages */
export class OrderStatus {
  /** @title Status */
  value: 'incoming' | 'kitchen' | 'ready' = 'incoming'

  /** @description Advance order to the next stage */
  advance() {
    if (this.value === 'incoming') this.value = 'kitchen'
    else if (this.value === 'kitchen') this.value = 'ready'
  }
}
```

Without `@description`, the action appears in MCP's `catalog` with no explanation — AI tools can see it exists but don't know what it does.

### Helper methods

All prototype methods are registered as actions. Keep internal helpers as standalone functions outside the class, not as methods.

### Typed arguments

Method parameter types generate argument schemas automatically:

```typescript
addItem(data: { item: string; price: number }) {
  // Inspector shows: item (text input), price (number input)
}
```

## Cross-references

When a field's type is a registered class, `@refType` is auto-detected:

```typescript
export class CafeContact {
  /** @title Mail service */
  mailService?: CafeMailService  // → auto refType: "cafe.mail"
}
```

You can also declare it explicitly:

```typescript
/** @title Related sensor @refType sensor.config */
sensorPath = ''
```

## Schema Generation

Schemas auto-generate on dev server startup. In CI, boot the server once against a throwaway store before running checks that need schema files.

Under the hood, the schema extractor parses the AST, extracts JSDoc tags, and writes JSON Schema files to a `schemas/` directory next to the file that registers each Type.

## Checklist

1. Every class: first-line JSDoc `/** {Noun} — {what it does} */`
2. Every public field: `@title` (form label)
3. Fields that need special widgets: `@format`
4. Every public method: `@description` (action label for AI/Inspector)
5. Internal helpers: standalone functions outside the class
6. Schemas auto-generate on dev server startup
7. Verify: check `schemas/{type}.json` has title, properties, methods

## Related

- [Concepts: Types](../concepts/types.md) — registerType, naming convention
- [Guide: Create a Mod](create-a-mod.md) — types in the mod lifecycle
