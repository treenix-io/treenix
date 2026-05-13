# uix

Dynamic JSX-view compiler. Takes raw JSX/TSX from type nodes, compiles to React components at runtime via `jsx-parser`, registers them as `react`-context handlers. AI-generated views without a build step.

## Key
- `compileComponent(type, rawJSX)` — compile + cache + register
- `verifyViewSource` — server-safe compile check (used by MCP)
