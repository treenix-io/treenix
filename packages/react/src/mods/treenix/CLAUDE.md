# treenix

Системный мод платформы. Actions для `/sys` ноды: обнаружение типов (catalog, search_types, describe_type), компиляция JSX-views, деплой prefab'ов. Реестр модулей `t.mod`.

## Types
- `treenix.system` — actions: catalog, search_types, describe_type, compile_view, deploy_prefab
- `t.mod` — name, state (discovered/loading/loaded/failed/disabled)
