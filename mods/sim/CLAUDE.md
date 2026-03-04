# sim

Раундовая мульти-агентная LLM-симуляция. Агенты на 2D-карте каждый раунд вызывают Claude (или mock) для speak/move/remember/interact. Actions обнаруживаются из реестра типов — любая нода с `action:*` становится интерактивной.

## Types (8 компонентов)
- `sim.position` — координаты x, y
- `sim.descriptive` — имя, описание, appearance
- `sim.memory` — memories[], reflections[]
- `sim.config` — world settings (размер, задержка, модель)
- `sim.round` — номер раунда
- `sim.events` — лог событий
- `sim.ai` — AI-настройки агента
- `sim.nearby` — proximity cache

## Services
- `sim.world` — раундовый цикл: think → dispatch tools → update state
