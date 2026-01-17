/**
 * Сервер для мультиплеерной игры "Змейка" (Telegram Mini App)
 * Node.js + Socket.io + lowdb
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const db = require('./db/database');
const { initUser, getUser, updateUser } = require('./db/users');
const gameLogic = require('./game/gameLogic');
const gameLoop = require('./game/gameLoop');
const paymentModule = require('./payment/paymentHandler');

// DEBUG MODE: Переключатель режимов
const DEBUG_MODE = true; // true = Тестовый режим, false = Боевой режим (TON)

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Маршруты для статических файлов
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/webapp', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Глобальные переменные для управления играми
const activeGames = new Map(); // gameId -> GameState
const waitingPlayers = new Map(); // userId -> { socketId, ready: false }
const playerToGame = new Map(); // userId -> gameId
const socketToUser = new Map(); // socketId -> userId

// Конфигурация игры
const GAME_CONFIG = {
  FIELD_WIDTH: 20,
  FIELD_HEIGHT: 20,
  TICK_RATE: 15, // тиков в секунду
  ENTRY_PRICE: 1, // стоимость входа (в играх)
  WINNER_PERCENTAGE: 0.75 // процент выигрыша победителя (75%)
};

// Инициализация базы данных
db.init().then(() => {
  console.log('✅ База данных инициализирована');
  
  // Запускаем игровой цикл (передаем endGame как callback)
  gameLoop.start(io, activeGames, GAME_CONFIG, endGame);
  console.log(`✅ Игровой цикл запущен (${GAME_CONFIG.TICK_RATE} тиков/сек)`);
}).catch(err => {
  console.error('❌ Ошибка инициализации БД:', err);
});

// Middleware для валидации initData от Telegram
function validateTelegramUser(socket, next) {
  const auth = socket.handshake.auth;
  if (!auth || !auth.user_id) {
    return next(new Error('Authentication failed: user_id required'));
  }
  next();
}

// Socket.io подключение
io.use(validateTelegramUser);

io.on('connection', async (socket) => {
  const userId = socket.handshake.auth.user_id;
  const username = socket.handshake.auth.username || `User_${userId}`;
  
  console.log(`🔌 Пользователь подключен: ${userId} (${username})`);
  socketToUser.set(socket.id, userId);
  
  // Инициализация пользователя в БД (если нового)
  await initUser(userId, username, DEBUG_MODE);
  
  // Отправляем информацию о режиме и балансе
  const user = await getUser(userId);
  socket.emit('user_data', {
    userId,
    username,
    games_balance: user.games_balance,
    winnings_usdt: user.winnings_usdt,
    debug_mode: DEBUG_MODE
  });
  
  // Поиск соперника или ожидание
  socket.on('find_match', async () => {
    await handleFindMatch(socket, userId);
  });
  
  // Готовность к игре
  socket.on('ready', async () => {
    await handleReady(socket, userId);
  });
  
  // Команда направления
  socket.on('direction', (direction) => {
    handleDirection(socket, userId, direction);
  });
  
  // Отключение
  socket.on('disconnect', () => {
    handleDisconnect(socket, userId);
  });
});

/**
 * Поиск соперника
 */
async function handleFindMatch(socket, userId) {
  // Проверяем баланс
  const user = await getUser(userId);
  if (user.games_balance < GAME_CONFIG.ENTRY_PRICE) {
    socket.emit('error', {
      message: `Недостаточно игр! Баланс: ${user.games_balance}, нужно: ${GAME_CONFIG.ENTRY_PRICE}`
    });
    return;
  }
  
  // Проверяем, не находится ли игрок уже в игре
  if (playerToGame.has(userId)) {
    socket.emit('error', { message: 'Вы уже в игре!' });
    return;
  }
  
  // Ищем ожидающего соперника
  const waitingUser = Array.from(waitingPlayers.keys()).find(id => id !== userId);
  
  if (waitingUser) {
    // Найден соперник - создаем игру
    const opponentSocketId = waitingPlayers.get(waitingUser).socketId;
    waitingPlayers.delete(waitingUser);
    
    await createGame(userId, waitingUser, socket.id, opponentSocketId);
  } else {
    // Нет соперника - добавляем в очередь ожидания
    waitingPlayers.set(userId, { socketId: socket.id, ready: false });
    socket.emit('waiting_opponent');
    console.log(`⏳ Игрок ${userId} ожидает соперника`);
  }
}

/**
 * Готовность игрока
 */
async function handleReady(socket, userId) {
  if (!waitingPlayers.has(userId)) {
    socket.emit('error', { message: 'Вы не в очереди!' });
    return;
  }
  
  const waitingData = waitingPlayers.get(userId);
  waitingData.ready = true;
  waitingPlayers.set(userId, waitingData);
  
  // Проверяем, готов ли соперник (если он есть)
  const gameId = playerToGame.get(userId);
  if (gameId && activeGames.has(gameId)) {
    const game = activeGames.get(gameId);
    const isPlayer1 = game.player1_id === userId;
    const opponentReady = isPlayer1 ? game.player2_ready : game.player1_ready;
    
    if (opponentReady) {
      // Оба готовы - начинаем игру
      await startGame(gameId);
    }
  }
  
  socket.emit('ready_confirmed');
}

/**
 * Создание игры
 */
async function createGame(player1Id, player2Id, socket1Id, socket2Id) {
  // Списываем баланс у обоих игроков
  const player1 = await getUser(player1Id);
  const player2 = await getUser(player2Id);
  
  // Проверка баланса
  if (player1.games_balance < GAME_CONFIG.ENTRY_PRICE || 
      player2.games_balance < GAME_CONFIG.ENTRY_PRICE) {
    // У кого-то недостаточно баланса
    const player1Socket = io.sockets.sockets.get(socket1Id);
    const player2Socket = io.sockets.sockets.get(socket2Id);
    
    if (player1.games_balance < GAME_CONFIG.ENTRY_PRICE) {
      player1Socket?.emit('error', { message: 'Недостаточно игр для начала матча!' });
    }
    if (player2.games_balance < GAME_CONFIG.ENTRY_PRICE) {
      player2Socket?.emit('error', { message: 'Недостаточно игр для начала матча!' });
    }
    return;
  }
  
  // Списываем баланс
  await updateUser(player1Id, { games_balance: player1.games_balance - GAME_CONFIG.ENTRY_PRICE });
  await updateUser(player2Id, { games_balance: player2.games_balance - GAME_CONFIG.ENTRY_PRICE });
  
  // Создаем игру
  const gameId = `game_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const gameState = gameLogic.createGame(player1Id, player2Id, GAME_CONFIG);
  
  activeGames.set(gameId, gameState);
  playerToGame.set(player1Id, gameId);
  playerToGame.set(player2Id, gameId);
  
  // Убираем из ожидания
  waitingPlayers.delete(player1Id);
  waitingPlayers.delete(player2Id);
  
  // Подключаем игроков к комнате игры
  const socket1 = io.sockets.sockets.get(socket1Id);
  const socket2 = io.sockets.sockets.get(socket2Id);
  
  if (socket1) {
    socket1.join(`game_${gameId}`);
    socket1.playerNumber = 1; // Сохраняем номер игрока
  }
  if (socket2) {
    socket2.join(`game_${gameId}`);
    socket2.playerNumber = 2; // Сохраняем номер игрока
  }
  
  // Уведомляем игроков
  socket1?.emit('game_created', { gameId, playerNumber: 1 });
  socket2?.emit('game_created', { gameId, playerNumber: 2 });
  
  console.log(`🎮 Игра ${gameId} создана: ${player1Id} vs ${player2Id}`);
}

/**
 * Запуск игры (после готовности обоих)
 */
async function startGame(gameId) {
  const game = activeGames.get(gameId);
  if (!game) return;
  
  game.is_running = true;
  game.start_time = Date.now();
  
  // Уведомляем игроков о старте
  io.to(`game_${gameId}`).emit('game_start', {
    gameId,
    start_time: game.start_time
  });
  
  console.log(`🚀 Игра ${gameId} началась!`);
}

/**
 * Обработка команды направления
 */
function handleDirection(socket, userId, direction) {
  const gameId = playerToGame.get(userId);
  if (!gameId || !activeGames.has(gameId)) {
    socket.emit('error', { message: 'Вы не в игре!' });
    return;
  }
  
  const game = activeGames.get(gameId);
  if (!game.is_running) {
    return; // Игра еще не началась
  }
  
  // Сохраняем команду направления
  gameLogic.setDirection(game, userId, direction);
}

/**
 * Завершение игры и начисление призов
 */
async function endGame(gameId, winnerId, loserId) {
  const game = activeGames.get(gameId);
  if (!game || game.finished) return;
  
  game.finished = true;
  game.end_time = Date.now();
  
  // Рассчитываем приз: (стоимость_входа * 2) * 0.75
  const pool = GAME_CONFIG.ENTRY_PRICE * 2; // Два входа
  const prize = pool * GAME_CONFIG.WINNER_PERCENTAGE; // 75% победителю
  
  // Начисляем приз победителю
  if (winnerId) {
    const winner = await getUser(winnerId);
    await updateUser(winnerId, {
      winnings_usdt: winner.winnings_usdt + prize
    });
    
    console.log(`🏆 Игра ${gameId} завершена. Победитель: ${winnerId}, приз: ${prize}`);
  }
  
  // Уведомляем игроков
  io.to(`game_${gameId}`).emit('game_end', {
    winnerId,
    prize: winnerId ? prize : 0,
    game_stats: {
      duration: game.end_time - game.start_time,
      pool
    }
  });
  
  // Очищаем из активных игр
  playerToGame.delete(game.player1_id);
  playerToGame.delete(game.player2_id);
  
  // Удаляем игру через 5 секунд (для истории)
  setTimeout(() => {
    activeGames.delete(gameId);
  }, 5000);
}

/**
 * Обработка отключения
 */
function handleDisconnect(socket, userId) {
  console.log(`🔌 Пользователь отключен: ${userId}`);
  
  // Удаляем из ожидания
  waitingPlayers.delete(userId);
  
  // Удаляем связь socket -> user
  socketToUser.delete(socket.id);
  
  // Если игрок в игре - завершаем игру
  const gameId = playerToGame.get(userId);
  if (gameId && activeGames.has(gameId)) {
    const game = activeGames.get(gameId);
    const isPlayer1 = game.player1_id === userId;
    const opponentId = isPlayer1 ? game.player2_id : game.player1_id;
    
    // Завершаем игру, противник побеждает
    endGame(gameId, opponentId, userId);
  }
  
  playerToGame.delete(userId);
}

// Экспорт функции endGame для использования в gameLoop
module.exports.endGame = endGame;

// HTTP маршруты для проверки баланса (без WebSocket)
app.get('/api/user/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const user = await getUser(userId);
    res.json({
      userId,
      games_balance: user.games_balance,
      winnings_usdt: user.winnings_usdt,
      debug_mode: DEBUG_MODE
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// HTTP маршрут для пополнения баланса (DEBUG_MODE)
app.get('/api/add-games/:userId', async (req, res) => {
  try {
    if (!DEBUG_MODE) {
      return res.status(403).json({ 
        success: false, 
        error: 'Пополнение баланса доступно только в DEBUG_MODE' 
      });
    }
    
    const userId = parseInt(req.params.userId);
    const amount = parseInt(req.query.amount) || 10;
    
    const result = await paymentModule.addGamesBalance(userId, amount, DEBUG_MODE);
    
    if (result.success) {
      const user = await getUser(userId);
      res.json({
        success: true,
        games_balance: user.games_balance,
        winnings_usdt: user.winnings_usdt,
        added: amount
      });
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(`🔧 Режим: ${DEBUG_MODE ? 'ТЕСТОВЫЙ (DEBUG_MODE)' : 'БОЕВОЙ (TON)'}`);
});

