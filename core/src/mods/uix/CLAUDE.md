# uix

Динамический компилятор JSX-views. Берёт raw JSX/TSX из type-нод, компилирует в React-компоненты в runtime через `jsx-parser`, регистрирует как `react`-контексты. AI-генерируемые views без билд-шага.

## Key
- `compileComponent(type, rawJSX)` — compile + cache + register
- `verifyViewSource` — server-safe compile check (используется MCP)
