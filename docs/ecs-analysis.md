# ECS в Treenix — анализ и решение

## Что такое ECS

Entity-Component-System — архитектурный паттерн из gamedev:

- **Entity** = ID (число). Контейнер для компонентов.
- **Component** = чистые данные, без логики. `Position { x, y }`, `Velocity { dx, dy }`.
- **System** = функция, итерирующая ВСЕ entity с нужным набором компонентов.

**S — ключевая инновация.** "Дай мне все entity с Position И Velocity" → System Physics обрабатывает пакетом. Это не OOP (нет наследования), не event-driven (нет подписок) — это batch processing по component queries.

## Что есть в Treenix

| ECS | Treenix | Статус |
|-----|----------|--------|
| Entity = ID | Node = $path + $type + components | ✅ Есть, даже лучше — путь даёт иерархию, ACL, mount points |
| Component = pure data | Component = data + methods | ⚠️ Методы нарушают чистый ECS, но дают typed actions бесплатно |
| System = batch query + tick | Нет. Логика в actions (user-triggered) и services (per-node) | ❌ Главный gap |
| Query = find by components | Только getChildren по path prefix + sift filter | ❌ Главный gap |
| Archetype storage | Map по path | ❌ Но не критично для нашего масштаба |

**Gap — ровно 2 вещи: Query по компонентам + System (tick loop).**

## Почему System = Service + Query

Services уже есть. System — это service, который на каждом тике делает query и обрабатывает результат:

```typescript
// Псевдокод — System как сервис:
register('physics', 'service', async (node, ctx) => {
  const timer = setInterval(async () => {
    const { items } = await ctx.store.query({
      hasType: ['sim.position', 'sim.velocity'],
    });
    for (const e of items) {
      const pos = getComponent(e, Position);
      const vel = getComponent(e, Velocity);
      pos.x += vel.dx * dt;
      pos.y += vel.dy * dt;
      await ctx.store.set(e);
    }
  }, 16);
  return { stop: () => clearInterval(timer) };
});
```

Не нужен новый примитив. Нужен `store.query()`.

## Что даёт добавление query

### store.query() — поиск по компонентам across all nodes

```typescript
interface Tree {
  // ... existing methods ...
  query(filter: QueryFilter, opts?: PageOpts): Promise<Page<NodeData>>;
}

type QueryFilter = {
  hasType?: string[];                  // любой component.$type matches
  match?: Record<string, unknown>;     // sift filter на полях
  scope?: string;                      // path prefix (опционально, для performance)
};
```

### Что открывает:

- **Inspector:** "покажи все ноды типа X" без навигации по дереву
- **three модуль:** "найди все объекты со ScriptRunner" — scene-wide
- **sim модуль:** "все агенты с sensor и position" → batch processing
- **marketplace search:** "какие типы используются в дереве"
- **Digital twins:** "все датчики с temperature > 50" по всему заводу/складу
- **Аналитика:** "сколько заказов в статусе kitchen" без знания path structure

### Реализация по store:

- **Memory tree:** secondary index `Map<type, Set<path>>`, обновляется на set/remove. O(1) lookup.
- **Mongo tree:** `db.collection.find({ _type: { $in: types } })` — native index
- **FS tree:** full dir walk + filter (медленно, но корректно)

### Оценка: 3-5 дней

## "Клон Unity" — нереально и не нужно

Unity: 30+ лет, тысячи инженеров, PhysX, HDRP, asset pipeline, cross-platform compilation, C# IL2CPP.

Treenix на JavaScript с async store **не может** быть Unity. Другой runtime, constraints, target.

## Реалистичная ниша: "Unity-like experience для non-game apps"

Unity слаб в: business apps, dashboards, collaborative tools, digital twins. Unity DOTS (их ECS) оптимизирован для performance, не для composition.

**Treenix покрывает:**

| Компонент | Unity | Treenix | Статус |
|-----------|-------|----------|--------|
| Hierarchy panel | ✅ | Tree browser | ✅ |
| Inspector | ✅ | Inspector + schema forms | ✅ |
| 3D viewport | ✅ | mods/three (react-three-fiber) | ⚠️ базовый |
| Component attach | ✅ | Inspector + setComponent | ✅ |
| Prefabs | ✅ | Templates (applyTemplate) | ✅ |
| Scene serialization | ✅ | Ноды в дереве (JSON) | ✅ бесплатно |
| Real-time collab | ❌ | OCC + subscriptions | ✅ |
| AI integration | ❌ | MCP + tree = нативно | ✅ |
| ACL / permissions | ❌ | GroupPerm + $acl | ✅ |

**60% базового Unity editor из коробки — не потому что копируем, а потому что tree + typed components + inspector = ядро любого entity editor.**

## Физика и tick loops

Физику обрабатывают **сервисы на поддеревьях**, не глобальная system. Это правильнее для наших кейсов:

```
/world/room-1/  → physics service (rapier.js)
/world/room-2/  → physics service (rapier.js)
/dashboard/     → no physics, just data nodes
```

Каждый поддерев может иметь свой tick rate, свой engine, свой scope. Глобальный tick loop а-ля Unity не нужен — у нас не 60fps game, а distributed data platform.

С query это станет чище: service стартует на поддереве, query находит все физические body в scope.

## Вывод

1. **ECS label честен ПОСЛЕ добавления query + systems.** До этого — нет.
2. **Query — единственная фича, трансформирующая Treenix.** ~5 дней работы.
3. **"Клон Unity" — wrong goal.** "Unity-like experience для non-game apps" — right goal.
4. **Не приоритет сейчас — стабилизация первична.** Query добавляем после зелёных тестов и стабильной базы.
5. **Физика = сервисы на поддеревьях.** Глобальный tick loop не нужен.
