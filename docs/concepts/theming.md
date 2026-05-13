---
title: Theming
section: concepts
order: 8
description: Standard Tailwind v4 + shadcn/ui theming — semantic CSS-variable tokens, dark mode by class
tags: [react, ui, theme]
---

# Theming

Treenix uses **standard Tailwind v4 + shadcn/ui theming**. There is nothing custom on top — every convention you read in the upstream docs applies directly.

- [Tailwind v4 — Theme](https://tailwindcss.com/docs/theme) — the `@theme` directive and `--color-*` / `--font-*` / `--radius-*` namespaces that auto-generate utility classes.
- [Tailwind v4 — Dark Mode](https://tailwindcss.com/docs/dark-mode) — how the `dark:` variant works and how to switch from `prefers-color-scheme` to class-based toggling.
- [shadcn/ui — Theming](https://ui.shadcn.com/docs/theming) — token names (`background`, `foreground`, `card`, `primary`, …) and the `:root` + `.dark` dark-mode pattern.

## Tokens

Tokens live in [`engine/packages/react/src/root.css`](../../packages/react/src/root.css) under `:root`, declared in Tailwind v4's `--color-*` namespace so Tailwind 4 exposes them as utility classes (`bg-card`, `text-primary`, …):

| Token | Tailwind classes | Role |
|---|---|---|
| `--color-background` | `bg-background` | App canvas |
| `--color-foreground` | `text-foreground` | Default text |
| `--color-card` / `-foreground` | `bg-card`, `text-card-foreground` | In-flow surface |
| `--color-popover` / `-foreground` | `bg-popover`, `text-popover-foreground` | Floating surface (menus, dialogs) |
| `--color-primary` / `-foreground` | `bg-primary`, `text-primary-foreground` | Brand action / interactive accent |
| `--color-secondary` / `-foreground` | `bg-secondary`, `text-secondary-foreground` | Subdued surface variant |
| `--color-muted` / `-foreground` | `bg-muted`, `text-muted-foreground` | De-emphasized surface / text |
| `--color-accent` / `-foreground` | `bg-accent`, `text-accent-foreground` | Hover / highlight tint |
| `--color-destructive` / `-foreground` | `bg-destructive`, `text-destructive-foreground` | Errors, destructive actions |
| `--color-border`, `--color-input`, `--color-ring` | `border-border`, `border-input`, `ring-ring` | Borders, form fields, focus rings |

Radius (`--radius-sm/-md/-lg`) and the Manrope font (`font-sans`) are declared in the same block. See [shadcn docs](https://ui.shadcn.com/docs/theming) for the canonical semantics of each token.

## Current state

Two themes live in [`root.css`](../../packages/react/src/root.css): light under `:root`, dark under `.dark`. The `@custom-variant dark (&:where(.dark, .dark *))` directive is declared in [`index.html`](../../packages/react/index.html) inside a `<style type="text/tailwindcss">` block — Tailwind v4 browser CDN only parses directives there, not from CSS files. shadcn `dark:` utilities activate by class.

Default is dark — set by a FOUC script in `index.html` that adds `.dark` before first paint unless `localStorage['treenix-theme']` is `'light'`.

## Switching themes

```tsx
import { useTheme } from '@treenx/react';

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
      {theme === 'dark' ? '☀' : '☾'}
    </button>
  );
}
```

`setTheme('dark' | 'light')` toggles the `.dark` class and persists to `localStorage`.

## Runtime custom themes

`useTheme().setCustomTheme({ name, tokens })` injects an inline `<style>` element with token overrides and applies `.theme-<name>` on `<html>`. Customs layer on top of dark/light via CSS specificity. They are runtime-only — not persisted across reloads in v2.

```tsx
const { setCustomTheme, clearCustomTheme } = useTheme();
setCustomTheme({
  name: 'cafe',
  tokens: {
    '--color-primary': '#fbbf24',
    '--color-accent': 'rgba(251, 191, 36, 0.10)',
  },
});
// Later:
clearCustomTheme('cafe');
```

## Anti-patterns in views

| Don't write | Use instead |
|---|---|
| `bg-zinc-900`, `bg-zinc-950`, `bg-[#151515]` | `bg-background`, `bg-card` |
| `text-zinc-100`, `text-[#fafafa]` | `text-foreground` |
| `text-zinc-400`, `text-zinc-500` | `text-muted-foreground` |
| `border-zinc-700`, `border-white/10` | `border-border` |
| `bg-emerald-400` (brand) | `bg-primary` |
| `bg-red-500` (destructive) | `bg-destructive` |
| `style={{ color: '#…' }}` | Tailwind token class |

Token classes adapt to whatever theme is active. Hardcoded palette classes do not.

Discover offenders:

```bash
grep -rln 'bg-zinc-\|text-zinc-\|border-zinc-' mods engine/mods engine/packages/react/src/mods
```

## See also

- [`packages/react/src/components/ui/`](./packages/react/src/components/ui/) — shadcn primitives wired to the tokens above.
- [React Views guide](../guides/react-views.md) — view patterns; views should compose tokens, not concrete colors.
