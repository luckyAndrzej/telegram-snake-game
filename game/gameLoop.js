/**
 * Игровой цикл (Game Loop)
 * Обновляет все активные игры с заданной частотой (15-20 тиков/сек)
 */

const gameLogic = require('./gameLogic');

let gameLoopInterval = null;
let tickInterval = null; // Интервал между тиками в миллисекундах
// Кэш последних отправленных состояний для дебаунсинга (gameId -> last state hash)
const lastSentStateCache = new Map();

/**
 * Запустить игровой цикл
 */
function start(io, activeGames, config, endGameCallback) {
  // Вычисляем интервал между тиками (1000ms / TICK_RATE)
  // TICK_RATE обычно 15-20 тиков/сек для логики игры
  tickInterval = 1000 / config.TICK_RATE; // Например, 1000/18 = 55.56ms
  
  // Throttle для отправки game_state: отправляем с частотой тиков для плавности
  const SEND_RATE = config.TICK_RATE; // Отправляем с той же частотой, что и тики (9 раз в секунду)
  const sendInterval = 1000 / SEND_RATE; // ~111ms между отправками (замедлено в 2 раза)
  let lastSendTime = 0;
  
  // Запускаем цикл обновления игры
  gameLoopInterval = setInterval(() => {
    const currentTime = Date.now();
    const gameIds = Array.from(activeGames.keys());
    
    if (gameIds.length === 0) {
      return; // Нет активных игр
    }
    
    // Обновляем каждую игру
    gameIds.forEach(gameId => {
      const game = activeGames.get(gameId);
      if (!game || game.finished) return;
      
      if (game.is_running) {
        // Выполняем тик игры (внутренняя логика всегда обновляется)
        const result = gameLogic.tick(game);
        
        // ОПТИМИЗАЦИЯ: Используем setImmediate для рассылки состояний,
        // чтобы они не блокировались тяжелыми запросами к БД
        const currentTime = Date.now();
        if (currentTime - lastSendTime >= sendInterval) {
          // Откладываем рассылку на следующий тик event loop
          setImmediate(() => {
            broadcastGameState(io, game, gameId);
          });
          lastSendTime = currentTime;
        }
        
        // Если игра завершена - уведомляем
        if (result.finished && endGameCallback) {
          // Если ничья (result.winner === null), передаем null для обоих параметров
          if (result.winner === null) {
            endGameCallback(gameId, null, null);
          } else {
            const loserId = result.winner === game.player1_id ? game.player2_id : game.player1_id;
            endGameCallback(gameId, result.winner, loserId);
          }
        }
      }
    });
    
  }, tickInterval);
}

/**
 * Broadcast состояния игры всем игрокам (максимально оптимизировано - только координаты x,y)
 */
function broadcastGameState(io, game, gameId) {
  // ОПТИМИЗАЦИЯ: Дебаунсинг - отправляем только если состояние реально изменилось
  // Создаем простой хеш состояния (координаты голов + тик + статусы)
  const head1 = game.snake1.body[0];
  const head2 = game.snake2.body[0];
  const stateHash = `${head1.x},${head1.y},${head2.x},${head2.y},${game.tick_number},${game.snake1.alive ? 1 : 0},${game.snake2.alive ? 1 : 0},${game.finished ? 1 : 0}`;
  
  // Проверяем, изменилось ли состояние
  const lastHash = lastSentStateCache.get(gameId);
  if (lastHash === stateHash) {
    // Состояние не изменилось - пропускаем отправку (экономия трафика и CPU)
    return;
  }
  
  // Состояние изменилось - обновляем кэш и отправляем
  lastSentStateCache.set(gameId, stateHash);
  
  // Очищаем кэш для завершенных игр
  if (game.finished) {
    lastSentStateCache.delete(gameId);
  }
  
  // Оптимизация: отправляем только координаты x,y в виде массивов [x, y] для каждого сегмента
  // Это значительно уменьшает размер пакета по сравнению с объектами {x, y}
  const optimizeBody = (body) => {
    if (!body || !Array.isArray(body)) return [];
    // Преобразуем [{x, y}, {x, y}] в [[x, y], [x, y]] - экономия ~30-40% размера
    return body.map(segment => [segment.x, segment.y]);
  };
  
  // Минимальный snapshot: только координаты и направление
  const lightweightState = {
    t: game.tick_number, // tick (сокращенно)
    s1: optimizeBody(game.snake1.body), // snake1 body: [[x,y], [x,y], ...]
    s2: optimizeBody(game.snake2.body), // snake2 body: [[x,y], [x,y], ...]
    s1a: game.snake1.alive ? 1 : 0, // snake1 alive (0/1 вместо boolean)
    s2a: game.snake2.alive ? 1 : 0, // snake2 alive (0/1 вместо boolean)
    s1d: [game.snake1.direction.dx, game.snake1.direction.dy], // direction как [dx, dy]
    s2d: [game.snake2.direction.dx, game.snake2.direction.dy], // direction как [dx, dy]
    f: game.finished ? 1 : 0, // finished (0/1 вместо boolean)
    w: game.winner_id || null // winner_id (может быть null)
  };
  
  // Отправляем каждому игроку его персональный view
  const roomName = `game_${gameId}`;
  const room = io.sockets.adapter.rooms.get(roomName);
  
  if (!room || room.size === 0) return;

  if (room) {
    room.forEach(socketId => {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
        const playerNumber = socket.playerNumber;
        
        // Восстанавливаем структуру для клиента (преобразуем массивы обратно в объекты)
        const restoreBody = (bodyArray) => {
          if (!bodyArray || !Array.isArray(bodyArray)) return [];
          return bodyArray.map(segment => ({ x: segment[0], y: segment[1] }));
        };
        
        const restoreDirection = (dirArray) => {
          if (!dirArray || !Array.isArray(dirArray) || dirArray.length < 2) return { dx: 1, dy: 0 };
          return { dx: dirArray[0], dy: dirArray[1] };
        };
        
        // Формируем персональный view на основе playerNumber
        const personalView = {
          gameId: game.gameId,
          tick_number: lightweightState.t,
          my_snake: {
            body: restoreBody(playerNumber === 1 ? lightweightState.s1 : lightweightState.s2),
            alive: (playerNumber === 1 ? lightweightState.s1a : lightweightState.s2a) === 1,
            direction: restoreDirection(playerNumber === 1 ? lightweightState.s1d : lightweightState.s2d)
          },
          opponent_snake: {
            body: restoreBody(playerNumber === 1 ? lightweightState.s2 : lightweightState.s1),
            alive: (playerNumber === 1 ? lightweightState.s2a : lightweightState.s1a) === 1,
            direction: restoreDirection(playerNumber === 1 ? lightweightState.s2d : lightweightState.s1d)
          },
          finished: lightweightState.f === 1,
          winner_id: lightweightState.w
        };
        socket.emit('game_state', personalView);
      }
    });
  }
}

/**
 * Остановить игровой цикл
 */
function stop() {
  if (gameLoopInterval) {
    clearInterval(gameLoopInterval);
    gameLoopInterval = null;
    lastSentStateCache.clear();
  }
}

module.exports = {
  start,
  stop
};

