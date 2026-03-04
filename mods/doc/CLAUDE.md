# doc mod

Rich document editing with Tiptap. Markdown files on disk become typed `doc.page` nodes.

## Type

**`doc.page`** — title (string) + content (Tiptap JSON string)

## FS Codec

Registered on `text/markdown` mime type:
- **decode:** `.md` file → `doc.page` node. First `# H1` extracted as `title`, rest → Tiptap JSON `content`
- **encode:** `doc.page` node → `.md` file. Title prepended as `# Title`, content converted via `tiptapToMd()`

## Markdown ↔ Tiptap

`markdown.ts` — bidirectional converter. Supports: headings, paragraphs, bold/italic/code, bullet/ordered lists, code blocks, blockquotes, horizontal rules, treenityBlock references.

## Editor (frontend)

Tiptap WYSIWYG with:
- Toolbar: bold, italic, code, H1-H3, lists, quote, code block, HR
- Slash commands: `/` opens menu for formatting + embedding Treenity nodes
- Drag-and-drop: drop tree nodes to embed as `treenityBlock`
- Embedded nodes rendered via `<Render>` with live data

## Prefabs

- **`doc/library`** — FS mount-point for a docs directory. Setup param: `{ root: string }`
- **`doc/demo`** — sample `doc.page` node

## Files

```
types.ts          — DocPage class + registerComp
fs-codec.ts       — text/markdown decode/encode for FS store
markdown.ts       — mdToTiptap / tiptapToMd converters
text.ts           — text context (Tiptap → plain text/markdown)
renderers.tsx     — Tiptap editor view
treenity-block.ts — custom Tiptap node type for embedded components
treenity-block-view.tsx — renders embedded Treenity nodes
toolbar.tsx       — editor toolbar
slash-command.ts  — Tiptap Suggestion extension
slash-menu.tsx    — slash command popup
node-picker.tsx   — tree browser for embedding
prefab.ts         — prefab registrations
server.ts         — server imports
client.ts         — client imports + view registration
```
