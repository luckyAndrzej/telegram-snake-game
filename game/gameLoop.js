/**
 * Игровой цикл (Game Loop)
 * Обновляет все активные игры с заданной частотой (15-20 тиков/сек)
 */

const gameLogic = require('./gameLogic');

let gameLoopInterval = null;
let tickInterval = null; // Интервал между тиками в миллисекундах

/**
 * Запустить игровой цикл
 */
function start(io, activeGames, config, endGameCallback) {
  // Вычисляем интервал между тиками (1000ms / TICK_RATE)
  // TICK_RATE обычно 15-20 тиков/сек для логики игры
  tickInterval = 1000 / config.TICK_RATE; // Например, 1000/15 = 66.67ms
  
  // Throttle для отправки game_state: отправляем только 15-20 раз в секунду (50-60 FPS для клиента)
  const SEND_RATE = 20; // 20 обновлений в секунду (50ms между отправками)
  const sendInterval = 1000 / SEND_RATE; // 50ms
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
        
        // Отправляем состояние игры всем игрокам только с нужной частотой (throttle)
        const currentTime = Date.now();
        if (currentTime - lastSendTime >= sendInterval) {
          broadcastGameState(io, game, gameId);
          lastSendTime = currentTime;
        }
        
        // Если игра завершена - уведомляем
        if (result.finished && endGameCallback) {
          const loserId = result.winner === game.player1_id ? game.player2_id : game.player1_id;
          endGameCallback(gameId, result.winner, loserId);
        }
      }
    });
  }, tickInterval);
  
  console.log(`✅ Игровой цикл запущен: ${config.TICK_RATE} тиков/сек (интервал: ${tickInterval.toFixed(2)}ms)`);
}

/**
 * Broadcast состояния игры всем игрокам (оптимизировано - только минимальные данные)
 */
function broadcastGameState(io, game, gameId) {
  // Отправляем только измененные данные (координаты змеек и минимальная мета-информация)
  // Создаем легковесный snapshot только с координатами тел змеек
  const lightweightState = {
    tick: game.tick_number,
    s1: game.snake1.body, // snake1 body coordinates
    s2: game.snake2.body, // snake2 body coordinates
    s1a: game.snake1.alive, // snake1 alive
    s2a: game.snake2.alive, // snake2 alive
    s1d: game.snake1.direction, // snake1 direction
    s2d: game.snake2.direction, // snake2 direction
    f: game.finished, // finished
    w: game.winner_id // winner_id
  };
  
  // Отправляем каждому игроку его персональный view
  const roomName = `game_${gameId}`;
  const room = io.sockets.adapter.rooms.get(roomName);
  
  // Логирование для диагностики (только если комната пуста или есть проблемы)
  if (!room || room.size === 0) {
    console.warn(`⚠️ Комната ${roomName} пуста или не найдена при отправке game_state (tick: ${game.tick_number})`);
    return;
  }
  
  if (room) {
    room.forEach(socketId => {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
        const playerNumber = socket.playerNumber;
        // Формируем персональный view на основе playerNumber
        const personalView = {
          gameId: game.gameId,
          tick_number: lightweightState.tick,
          my_snake: {
            body: playerNumber === 1 ? lightweightState.s1 : lightweightState.s2,
            alive: playerNumber === 1 ? lightweightState.s1a : lightweightState.s2a,
            direction: playerNumber === 1 ? lightweightState.s1d : lightweightState.s2d
          },
          opponent_snake: {
            body: playerNumber === 1 ? lightweightState.s2 : lightweightState.s1,
            alive: playerNumber === 1 ? lightweightState.s2a : lightweightState.s1a,
            direction: playerNumber === 1 ? lightweightState.s2d : lightweightState.s1d
          },
          finished: lightweightState.f,
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
    console.log('⏹ Игровой цикл остановлен');
  }
}

module.exports = {
  start,
  stop
};

