# autostart

Init.d-style pattern. Walks `/sys/autostart`, resolves ref children, starts each one's service context. Tracks state under `/proc/`. Exposes `start` / `stop` actions.

## Types
- `autostart` — `start` / `stop` actions
