# metatron

AI-оркестратор. Хранит Claude-диалоги как `metatron.task` ноды со структурированным `LogBlock[]` логом. Сервис следит за `running` тасками, собирает промпт из skills/memory/history, гонит Claude-turns. Параллельная обработка через `active: Set<string>`.

## Types
- `metatron.config` — model, systemPrompt, service
- `metatron.task` — prompt, status, log[], actions: task/reply/approve
- `metatron.skill` — named prompt fragment
- `metatron.memory` — persistent context

## Smart Permissions
- `ALLOWED_TOOLS` — generous whitelist, SDK auto-approves (never calls canUseTool)
- `NEEDS_APPROVAL` — only `remove_node` needs interactive user approval
- `canUseTool` — auto-allows anything not in NEEDS_APPROVAL; session memory auto-approves after first allow
- `metatron.permission` LogBlock — id, tool, input, status (pending/approved/denied)
- `approve` action on task — sets block status + resolves waiting canUseTool Promise
- Permission blocks flush immediately (bypass 2s debounce) for instant UI visibility

## Parallel Execution
- `active: Set<string>` tracks running task paths (replaces `processing` boolean)
- `processRunning()` finds ALL running tasks not in active set, fires each independently (no await)
- Each `processTask()` self-contained: add to active → run → delete from active → recheck
