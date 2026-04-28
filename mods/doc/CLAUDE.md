# doc mod

Rich document editing with Tiptap. Markdown files on disk become typed `doc.page` nodes.

## Type

**`doc.page`** — title (string) + content (Tiptap JSON object — stored as object, not string, so tree patches diff at field level)

## FS Codec

Registered on `text/markdown` mime type:
- **decode:** `.md` file → `doc.page` node. First `# H1` extracted as `title`, rest → Tiptap JSON `content` (object)
- **encode:** `doc.page` node → `.md` file. Title prepended as `# Title`, content (object) converted via `tiptapToMd()`

## Markdown ↔ Tiptap

`markdown.ts` — bidirectional converter. Supports: headings, paragraphs, bold/italic/code, bullet/ordered lists, code blocks, blockquotes, horizontal rules, treenixBlock references.

## Editor (frontend)

Tiptap WYSIWYG with:
- Toolbar: bold, italic, code, H1-H3, lists, quote, code block, HR
- Slash commands: `/` opens menu for formatting + embedding Treenix nodes
- Drag-and-drop: drop tree nodes to embed as `treenixBlock`
- Embedded nodes rendered via `<Render>` with live data

## Prefabs

- **`doc/library`** — FS mount-point for a docs directory. Setup param: `{ root: string }`
- **`doc/demo`** — sample `doc.page` node

## Files

```
types.ts          — DocPage class + registerType
fs-codec.ts       — text/markdown decode/encode for FS store
markdown.ts       — mdToTiptap / tiptapToMd converters
text.ts           — text context (Tiptap → plain text/markdown)
renderers.tsx     — Tiptap editor view
treenix-block.ts — custom Tiptap node type for embedded components
treenix-block-view.tsx — renders embedded Treenix nodes
toolbar.tsx       — editor toolbar
slash-command.ts  — Tiptap Suggestion extension
slash-menu.tsx    — slash command popup
node-picker.tsx   — tree browser for embedding
prefab.ts         — prefab registrations
server.ts         — server imports
client.ts         — client imports + view registration
```
