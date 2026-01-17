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
  tickInterval = 1000 / config.TICK_RATE; // Например, 1000/15 = 66.67ms
  
  // Запускаем цикл
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
        // Выполняем тик игры
        const result = gameLogic.tick(game);
        
        // Отправляем состояние игры всем игрокам
        broadcastGameState(io, game, gameId);
        
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
 * Broadcast состояния игры всем игрокам
 */
function broadcastGameState(io, game, gameId) {
  // Получаем снимки для каждого игрока
  const snapshot1 = gameLogic.getGameSnapshot(game, game.player1_id);
  const snapshot2 = gameLogic.getGameSnapshot(game, game.player2_id);
  
  // Отправляем каждому игроку его персональный snapshot через отдельные сокеты
  // Находим все сокеты в комнате и отправляем персональные данные
  const room = io.sockets.adapter.rooms.get(`game_${gameId}`);
  if (room) {
    room.forEach(socketId => {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
        const playerNumber = socket.playerNumber;
        const snapshot = playerNumber === 1 ? snapshot1 : snapshot2;
        socket.emit('game_state', snapshot);
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

