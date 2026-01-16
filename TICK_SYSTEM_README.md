# Система игровых тиков - Документация

## Обзор

Реализована система тиков для идеальной синхронизации мультиплеерной игры змейка 1v1.

### Ключевые особенности:
- **Фиксированные тики**: Игра обновляется строго каждые 500ms
- **Очередь команд**: Каждый игрок может отправить направление в любой момент, но применяется только САМАЯ ПОСЛЕДНЯЯ команда за тик
- **Защита от старых команд**: Команды старше 2 секунд игнорируются
- **Синхронизация через tick_number**: Клиент получает номер тика для игнорирования устаревших обновлений
- **Авторитетный сервер**: Только сервер обновляет состояние игры, клиенты только получают снимки

## Архитектура

### 1. `game.py` - Класс Game с поддержкой тиков

**Новые поля:**
- `tick_number: int` - Номер текущего тика
- `last_tick_time: float` - Timestamp последнего тика
- `pending_directions: Dict[int, Tuple[Direction, float]]` - Очередь последних направлений игроков

**Новые методы:**
- `queue_direction(player_id, direction, timestamp)` - Добавляет направление в очередь (заменяет предыдущее от того же игрока)
- `tick(current_time)` - Выполняет один игровой тик (применяет направления, обновляет игру, увеличивает tick_number)
- `get_snapshot()` - Возвращает полный снимок состояния игры включая tick_number

### 2. `game_loop.py` - Asyncio задача игрового цикла

**Функции:**
- `game_tick_loop(active_games)` - Основной цикл тиков (async)
- `start_game_tick_loop(active_games)` - Запускает игровой цикл в asyncio задаче
- `stop_game_tick_loop()` - Останавливает игровой цикл

**Логика:**
1. Спит TICK_INTERVAL (0.5 секунды)
2. Для каждой активной игры вызывает `game.tick()`
3. Повторяет

### 3. `webapp_api.py` - Обновленные эндпоинты

**Изменения:**
- `/api/game/direction` - Теперь использует `game.queue_direction()` вместо `game.set_direction()`
  - НЕ обновляет игру сразу
  - Сохраняет команду для следующего тика
  - Возвращает `direction_queued: True` и `tick_number`

- `/api/game/state` - Теперь возвращает `tick_number` и `last_tick_time`
  - НЕ обновляет игру (это делает game_tick_loop)
  - Просто возвращает текущее состояние (обновленное последним тиком)

**Автозапуск игрового цикла:**
- Игровой цикл запускается автоматически при импорте `webapp_api.py`
- Запускается в отдельном daemon-потоке (для совместимости с Flask)

## Использование

### На сервере:

```python
# Игровой цикл запускается автоматически при импорте webapp_api
from webapp_api import app
app.run(host='0.0.0.0', port=5000)
```

### На клиенте (JavaScript):

```javascript
// Отправка направления (команда сохраняется для следующего тика)
const response = await fetch('/api/game/direction', {
    method: 'POST',
    body: JSON.stringify({
        user_id: userId,
        direction: 'up'  // или 'down', 'left', 'right'
    })
});

const data = await response.json();
console.log(`Direction queued for tick ${data.tick_number}`);

// Получение состояния игры (обновленное последним тиком)
const stateResponse = await fetch('/api/game/state', {
    method: 'POST',
    body: JSON.stringify({ user_id: userId })
});

const gameState = await stateResponse.json();
console.log(`Current tick: ${gameState.tick_number}`);
console.log(`My snake:`, gameState.my_snake.body);
console.log(`Opponent snake:`, gameState.opponent_snake.body);

// Игнорируйте устаревшие обновления, сравнивая tick_number
if (gameState.tick_number > lastReceivedTick) {
    lastReceivedTick = gameState.tick_number;
    // Обновляем UI с новым состоянием
}
```

## Преимущества новой системы

1. **Идеальная синхронизация**: Оба игрока видят одно и то же состояние (обновленное каждые 500ms)
2. **Защита от race conditions**: Все команды обрабатываются строго по тикам, последняя команда выигрывает
3. **Защита от лагов**: Старые команды (>2 секунд) игнорируются
4. **Предсказуемость**: Игра обновляется строго по расписанию, независимо от задержек сети
5. **Масштабируемость**: Один игровой цикл обрабатывает все активные игры

## Настройки

В `game_loop.py`:
```python
TICK_INTERVAL = 0.5  # Интервал между тиками в секундах (500ms)
```

В `game.py`:
```python
MAX_COMMAND_AGE = 2.0  # Максимальный возраст команды в секундах
```

## Отладка

Логирование:
- `game_tick_loop`: Логирует каждый тик и статистику игр
- `queue_direction`: Логирует каждую сохраненную команду
- `tick`: Логирует завершение игры

Проверка работы:
```python
from game_loop import is_game_loop_running
print(f"Game loop running: {is_game_loop_running()}")

game = active_games[game_id]
print(f"Tick number: {game.tick_number}")
print(f"Last tick time: {game.last_tick_time}")
print(f"Pending directions: {game.pending_directions}")
```

## Миграция с старой системы

Старые методы `game.set_direction()` и `game.update()` оставлены для обратной совместимости, но рекомендуется использовать новые:
- `game.queue_direction()` вместо `game.set_direction()`
- `game.tick()` вместо `game.update()`

Старые методы будут работать, но не обеспечивают синхронизацию по тикам.

