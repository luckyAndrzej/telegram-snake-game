// Загрузка переменных окружения ДО всех остальных импортов
const path = require('path');
const result = require('dotenv').config({ path: path.join(__dirname, '.env') });

// Fallback значения (используются, если .env не загружен или переменные не определены)
const FALLBACK_IS_TESTNET = true; // Принудительно true для теста
const FALLBACK_WALLET = '0QCD6bCJwyuK7Kl21EBORyeY2UdJ5o_dJ5MmdO1ARZzXxL-v';
const FALLBACK_API_KEY = 'bd0ac1e83d4f3ef6f7358adba6f2cc1b720873da9f30716d5e412b79a22fd728';

if (result.error) {
  const envPath = path.join(__dirname, '.env');
  console.warn(`⚠️ ВНИМАНИЕ: Файл .env не найден по пути ${envPath}.`);
  console.warn(`   Используются ручные настройки для TESTNET (fallback значения).`);
  console.warn(`   Подробности ошибки: ${result.error.message}`);
} else {
  console.log('✅ Файл .env успешно загружен из: ' + path.join(__dirname, '.env'));
}

/**
 * Сервер для мультиплеерной игры "Змейка" (Telegram Mini App)
 * Node.js + Socket.io + lowdb
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const db = require('./db/database');
const { initUser, getUser, updateUser } = require('./db/users');
const gameLogic = require('./game/gameLogic');
const gameLoop = require('./game/gameLoop');
const paymentModule = require('./payment/paymentHandler');
const tonPayment = require('./payment/tonPayment');

// DEBUG MODE: Переключатель режимов
// По умолчанию false (боевой режим) для продакшена
// Для тестового режима установите DEBUG_MODE=true в переменных окружения Railway
const DEBUG_MODE = process.env.DEBUG_MODE === 'true'; // true = Тестовый режим, false = Боевой режим (TON)

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
  FIELD_WIDTH: 30, // Увеличено с 20 до 30 (больше клеток для передвижения)
  FIELD_HEIGHT: 30, // Увеличено с 20 до 30
  TICK_RATE: 6, // тиков в секунду (замедлено в 2.5 раза: было 15, стало 6)
  ENTRY_PRICE: 1, // стоимость входа (в играх)
  WINNER_PERCENTAGE: 0.75 // процент выигрыша победителя (75%)
};

// Инициализация базы данных
db.init().then(async () => {
  console.log('✅ База данных инициализирована');
  
  // Инициализация файлов для TON платежей (если не DEBUG_MODE)
  if (!DEBUG_MODE) {
    await tonPayment.initPaymentFiles();
    
    // Используем fallback значения, если переменные окружения не определены
    const IS_TESTNET = process.env.IS_TESTNET === 'true' || process.env.IS_TESTNET === true || process.env.IS_TESTNET === 'TRUE' || FALLBACK_IS_TESTNET;
    const WALLET = process.env.TON_WALLET_ADDRESS || FALLBACK_WALLET;
    const API_KEY = process.env.TONCENTER_API_KEY || FALLBACK_API_KEY;
    
    // Определяем, используются ли fallback значения
    const usingFallback = !process.env.IS_TESTNET || !process.env.TON_WALLET_ADDRESS || !process.env.TONCENTER_API_KEY;
    
    // Устанавливаем правильный API URL на основе IS_TESTNET
    const API_URL = IS_TESTNET ? 'https://testnet.toncenter.com/api/v2' : 'https://toncenter.com/api/v2';
    
    // Логирование конфигурации
    if (usingFallback) {
      const envPath = path.join(__dirname, '.env');
      console.warn(`⚠️ ВНИМАНИЕ: Файл .env не найден по пути ${envPath}. Используются ручные настройки для TESTNET.`);
      console.log(`✅ WALLET: ${WALLET.substring(0, 5)}...`);
      console.log(`✅ API_URL: ${API_URL}`);
    }
    
    // Логирование переменных окружения для отладки
    console.log('🔍 Проверка переменных окружения:');
    console.log(`   process.env.IS_TESTNET = "${process.env.IS_TESTNET || 'undefined (используется fallback)'}" (type: ${typeof process.env.IS_TESTNET})`);
    console.log(`   process.env.TON_WALLET_ADDRESS = "${process.env.TON_WALLET_ADDRESS ? process.env.TON_WALLET_ADDRESS.substring(0, 10) + '...' : 'undefined (используется fallback)'}"`);
    console.log(`   process.env.TONCENTER_API_KEY = "${process.env.TONCENTER_API_KEY ? '***' + process.env.TONCENTER_API_KEY.slice(-4) : 'undefined (используется fallback)'}"`);
    
    console.log(`✅ ПРОВЕРКА: IS_TESTNET из файла = ${IS_TESTNET}${usingFallback ? ' (fallback)' : ''}`);
    
    // Инициализация конфигурации TON
    tonPayment.initConfig({
      IS_TESTNET: IS_TESTNET,
      TON_WALLET_ADDRESS: WALLET,
      TON_API_KEY: API_KEY  // Передаем как TON_API_KEY для совместимости с tonPayment.js
    });
    
    console.log(`🌐 TON Config: IS_TESTNET=${IS_TESTNET}, API_URL=${API_URL}`);
    console.log(`✅ ПРОВЕРКА: API Key загружен: ${!!API_KEY}`);

    // Запускаем сканер блокчейна (каждые 20 секунд)
    setInterval(() => {
      tonPayment.checkTonPayments(io); // Используем checkTonPayments как основной метод
    }, 20000); // 20 секунд
    console.log('✅ Сканер блокчейна TON запущен (интервал: 20 сек)');
    
    // Первая проверка сразу после запуска
    tonPayment.checkTonPayments(io);
  }
  
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
  
  // Присоединяем к комнате пользователя для отправки событий payment_success
  socket.join(`user_${userId}`);
  
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
  
  // Отмена поиска соперника
  socket.on('cancel_search', () => {
    if (waitingPlayers.has(userId)) {
      waitingPlayers.delete(userId);
      console.log(`❌ Игрок ${userId} отменил поиск соперника`);
      socket.emit('search_cancelled');
    }
  });
  
  // Готовность к игре
  socket.on('ready', async () => {
    await handleReady(socket, userId);
  });
  
  // Команда направления
  socket.on('direction', (direction) => {
    handleDirection(socket, userId, direction);
  });
  
  // Инициация покупки игр (Socket.io альтернатива для /api/create-payment)
  socket.on('initiatePurchase', async (data) => {
    try {
      if (DEBUG_MODE) {
        socket.emit('error', {
          message: 'TON платежи доступны только в боевом режиме (DEBUG_MODE=false)'
        });
        return;
      }

      const { packageId } = data;
      
      if (!packageId) {
        socket.emit('error', {
          message: 'packageId is required'
        });
        return;
      }

      // Проверяем, что пакет существует
      if (!['pkg_1', 'pkg_5', 'pkg_10'].includes(packageId)) {
        socket.emit('error', {
          message: 'Invalid packageId. Use: pkg_1, pkg_5, or pkg_10'
        });
        return;
      }

      const result = await tonPayment.createPayment(userId, packageId);
      
      if (result.success) {
        // Отправляем данные платежа клиенту
        socket.emit('purchase_initiated', result);
      } else {
        socket.emit('error', {
          message: result.error || 'Failed to create payment'
        });
      }
    } catch (error) {
      socket.emit('error', {
        message: error.message || 'Error initiating purchase'
      });
    }
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
  // Проверяем, находится ли игрок в игре
  const gameId = playerToGame.get(userId);
  if (!gameId || !activeGames.has(gameId)) {
    // Если не в игре, возможно он еще в очереди ожидания
    if (!waitingPlayers.has(userId)) {
      socket.emit('error', { message: 'Вы не в игре и не в очереди!' });
      return;
    }
    
    // Игрок в очереди ожидания
    const waitingData = waitingPlayers.get(userId);
    waitingData.ready = true;
    waitingPlayers.set(userId, waitingData);
    socket.emit('ready_confirmed');
    return;
  }
  
  // Игрок в активной игре - помечаем как готового
  const game = activeGames.get(gameId);
  const isPlayer1 = game.player1_id === userId;
  
  if (isPlayer1) {
    game.player1_ready = true;
  } else {
    game.player2_ready = true;
  }
  
  // Проверяем, готов ли соперник
  const opponentReady = isPlayer1 ? game.player2_ready : game.player1_ready;
  
  if (opponentReady) {
    // Оба готовы - начинаем игру
    await startGame(gameId);
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
  
  // Отправляем начальное состояние игры обоим игрокам
  const snapshot1 = gameLogic.getGameSnapshot(gameState, player1Id);
  const snapshot2 = gameLogic.getGameSnapshot(gameState, player2Id);
  
  // Уведомляем игроков о найденном сопернике (match_found)
  socket1?.emit('match_found', { 
    gameId, 
    playerNumber: 1,
    initial_state: snapshot1 // Начальное состояние для отображения во время countdown
  });
  socket2?.emit('match_found', { 
    gameId, 
    playerNumber: 2,
    initial_state: snapshot2 // Начальное состояние для отображения во время countdown
  });
  
  console.log(`🎮 Игра ${gameId} создана: ${player1Id} vs ${player2Id}`);
  
  // Запускаем countdown на сервере (3 секунды)
  startCountdown(gameId);
}

/**
 * Countdown перед началом игры (3 секунды на сервере)
 */
function startCountdown(gameId) {
  const game = activeGames.get(gameId);
  if (!game) return;
  
  // Змейки уже отрисованы в начальных позициях, но не двигаются
  game.is_running = false; // Игра еще не началась
  
  let count = 5; // Start countdown from 5 instead of 3
  const countdownInterval = setInterval(() => {
    // Отправляем событие countdown всем игрокам в комнате
    io.to(`game_${gameId}`).emit('countdown', {
      number: count,
      gameId
    });
    
    count--;
    
    if (count < 0) {
      clearInterval(countdownInterval);
      // Countdown завершен - начинаем игру
      startGame(gameId);
    }
  }, 1000);
}

/**
 * Запуск игры (после countdown)
 */
async function startGame(gameId) {
  const game = activeGames.get(gameId);
  if (!game) return;
  
  game.is_running = true;
  game.start_time = Date.now();
  
  // Уведомляем игроков о начале игры
  io.to(`game_${gameId}`).emit('game_start', {
    gameId,
    start_time: game.start_time
  });
  
  console.log(`🚀 Игра ${gameId} началась!`);
}

/**
 * Обработка команды направления
 */
// Кэш для быстрого доступа к направлениям (моментальный отклик)
const DIRECTIONS_MAP = {
  'up': { dx: 0, dy: -1 },
  'down': { dx: 0, dy: 1 },
  'left': { dx: -1, dy: 0 },
  'right': { dx: 1, dy: 0 }
};

function handleDirection(socket, userId, direction) {
  // Моментальная проверка - без задержек
  const gameId = playerToGame.get(userId);
  if (!gameId || !activeGames.has(gameId)) {
    return; // Убираем emit error для скорости - просто игнорируем
  }
  
  const game = activeGames.get(gameId);
  if (!game.is_running) {
    return; // Игра еще не началась - мгновенный выход
  }
  
  // Определяем текущую змейку игрока (быстрый доступ)
  const isPlayer1 = game.player1_id === userId;
  const currentSnake = isPlayer1 ? game.snake1 : game.snake2;
  
  // Получаем текущее направление змейки
  const currentDir = currentSnake.direction;
  
  // Преобразуем строку направления в объект направления (из кэша)
  const newDirection = DIRECTIONS_MAP[direction.toLowerCase()];
  if (!newDirection) {
    return; // Неверное направление - мгновенный выход
  }
  
  // Мгновенная проверка на поворот на 180° (запрещено) - без логирования для скорости
  if (currentDir.dx === -newDirection.dx && currentDir.dy === -newDirection.dy && 
      currentDir.dx !== 0 && currentDir.dy !== 0) {
    return; // Мгновенно игнорируем команду - не сохраняем направление
  }
  
  // Моментально сохраняем команду направления (только если не противоположное)
  gameLogic.setDirection(game, userId, direction);
}

/**
 * Завершение игры и начисление призов
 */
async function endGame(gameId, winnerId, loserId) {
  console.log(`🔔 endGame вызвана: gameId=${gameId}, winner=${winnerId}, loser=${loserId}`);
  
  const game = activeGames.get(gameId);
  if (!game) {
    console.log(`❌ Игра ${gameId} не найдена в activeGames`);
    return;
  }
  
  // Флаг для проверки, было ли уже отправлено событие game_end
  const shouldSendEvent = !game.finished;
  
  if (game.finished) {
    console.log(`⚠️ Игра ${gameId} уже завершена, пропускаем повторную обработку`);
    // НЕ выходим сразу - возможно событие не было отправлено в первый раз
    // Но если уже отправлено - не отправляем повторно
    if (game.end_event_sent) {
      console.log(`✅ Событие game_end уже было отправлено ранее`);
      return;
    }
    console.log(`⚠️ Игра завершена, но событие game_end не отправлено! Отправляем сейчас...`);
  }
  
  game.finished = true;
  game.end_time = Date.now();
  
  // Защита от повторного начисления по одному matchId
  if (game.winnings_paid) {
    console.log(`⚠️ Попытка повторного начисления по матчу [${gameId}]. Отклонено.`);
    // Все равно отправляем событие game_end, если оно еще не было отправлено
    if (!game.end_event_sent) {
      const roomName = `game_${gameId}`;
      io.to(roomName).emit('game_end', {
        winnerId,
        prize: 0,
        game_stats: {
          duration: game.end_time - game.start_time,
          pool: 0
        }
      });
      game.end_event_sent = true;
    }
    return;
  }
  
  // Фиксированная сумма выигрыша
  const winAmount = 1.5;
  let prize = 0; // По умолчанию приз = 0
  
  // Начисляем приз победителю
  if (winnerId) {
    // Проверка активности матча: выигрыш начисляется только если был хотя бы один тик
    if (game.tick_number === 0 || !game.tick_number) {
      console.log(`⚠️ Игра ${gameId} не имела тиков движения (tick_number=0). Выигрыш не начисляется.`);
      prize = 0;
    } else {
      try {
        const winner = await getUser(winnerId);
        
        // Проверяем, что это не бот (боты не имеют записи в БД или имеют специальный ID)
        // Начисляем выигрыш только реальному игроку
        if (winner && winner.tg_id) {
          // Начисляем выигрыш
          const newWinnings = (winner.winnings_usdt || 0) + winAmount;
          await updateUser(winnerId, {
            winnings_usdt: newWinnings
          });
          
          prize = winAmount;
          
          console.log(`🏆 Победа подтверждена! Игрок [${winnerId}] получает ${winAmount} USDT.`);
          console.log(`   Баланс выигрышей до: ${winner.winnings_usdt || 0}, после: ${newWinnings}`);
          console.log(`💰 Баланс игрока ${winnerId} обновлен на ${winAmount}$`);
          
          // Сразу отправляем обновленный баланс игроку через Socket.io
          const updatedUser = getUser(winnerId);
          io.to(`user_${winnerId}`).emit('balance_updated', {
            games_balance: updatedUser.games_balance,
            winnings_usdt: updatedUser.winnings_usdt
          });
          console.log(`📤 Отправлен обновленный баланс игроку ${winnerId}: winnings=${updatedUser.winnings_usdt}`);
        } else {
          console.log(`⚠️ Победитель ${winnerId} не найден в БД или является ботом. Выигрыш не начисляется.`);
          prize = 0;
        }
      } catch (error) {
        console.error(`❌ Ошибка при начислении приза:`, error);
        prize = 0;
      }
    }
  } else {
    console.log(`🏁 Игра ${gameId} завершена ничьей`);
    prize = 0;
  }
  
  // Помечаем, что выигрыш обработан (защита от повторного начисления)
  game.winnings_paid = true;
  
  // Уведомляем игроков (ОБЯЗАТЕЛЬНО отправляем событие, даже если игра уже завершена)
  if (!game.end_event_sent) {
    const roomName = `game_${gameId}`;
    console.log(`📤 Отправка game_end в комнату: ${roomName}`);
    
    const eventData = {
      winnerId,
      prize: prize, // Используем рассчитанный prize (может быть 1.5 или 0)
      game_stats: {
        duration: game.end_time - game.start_time,
        pool: GAME_CONFIG.ENTRY_PRICE * 2
      }
    };
    
    io.to(roomName).emit('game_end', eventData);
    game.end_event_sent = true; // Помечаем, что событие отправлено
    
    console.log(`✅ game_end отправлено игрокам в комнате ${roomName}:`, eventData);
  } else {
    console.log(`⚠️ Событие game_end уже было отправлено ранее, пропускаем`);
  }
  
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
  console.log(`🔍 Отключение: игрок ${userId}, gameId: ${gameId}`);
  
  if (gameId && activeGames.has(gameId)) {
    const game = activeGames.get(gameId);
    console.log(`🎮 Игра найдена: ${gameId}, игроки: ${game.player1_id}, ${game.player2_id}`);
    const isPlayer1 = game.player1_id === userId;
    const opponentId = isPlayer1 ? game.player2_id : game.player1_id;
    
    // Завершаем игру, противник побеждает
    console.log(`🏁 Завершение игры ${gameId}: победитель ${opponentId}, проигравший ${userId}`);
    endGame(gameId, opponentId, userId);
  } else {
    console.log(`⚠️ Игра не найдена для игрока ${userId} (gameId: ${gameId}, active: ${activeGames.has(gameId || '')})`);
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

// HTTP маршрут для создания платежа TON (не DEBUG_MODE)
app.post('/api/create-payment', async (req, res) => {
  try {
    if (DEBUG_MODE) {
      return res.status(403).json({ 
        success: false, 
        error: 'TON платежи доступны только в боевом режиме (DEBUG_MODE=false)' 
      });
    }

    const { userId, packageId } = req.body;
    
    if (!userId || !packageId) {
      return res.status(400).json({
        success: false,
        error: 'userId and packageId are required'
      });
    }

    // Проверяем, что пакет существует
    if (!['pkg_1', 'pkg_5', 'pkg_10'].includes(packageId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid packageId. Use: pkg_1, pkg_5, or pkg_10'
      });
    }

    const result = await tonPayment.createPayment(userId, packageId);
    
    if (result.success) {
      // Проверяем, что адрес кошелька настроен
      if (!result.walletAddress) {
        return res.status(500).json({
          success: false,
          error: 'TON_WALLET_ADDRESS is not configured. Please set it in Railway variables.'
        });
      }
      res.json(result);
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

