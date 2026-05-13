# sim

Round-based multi-agent LLM simulation. Agents on a 2D map call Claude (or a mock) every round to speak/move/remember/interact. Actions are discovered from the type registry — any node with `action:*` becomes interactive.

## Types (8 components)
- `sim.position` — `x`, `y` coordinates
- `sim.descriptive` — name, description, appearance
- `sim.memory` — `memories[]`, `reflections[]`
- `sim.config` — world settings (size, delay, model)
- `sim.round` — round number
- `sim.events` — event log
- `sim.ai` — agent AI settings
- `sim.nearby` — proximity cache

## Services
- `sim.world` — round loop: think → dispatch tools → update state
