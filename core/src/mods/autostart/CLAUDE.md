# autostart

Init.d-паттерн. Обходит `/sys/autostart`, резолвит ref-детей, запускает service-контекст каждого. Отслеживает состояние в `/proc/`. Экспонирует `start`/`stop` actions.

## Types
- `autostart` — start/stop actions
