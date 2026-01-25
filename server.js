// ЗАГРУЗКА ПЕРЕМЕННЫХ ОКРУЖЕНИЯ В САМОМ НАЧАЛЕ (до всех остальных импортов)
require('dotenv').config();

// Проверка и логирование загруженных переменных
console.log('📋 Проверка переменных окружения:');
console.log(`   IS_TESTNET: ${process.env.IS_TESTNET || 'не задано'}`);
console.log(`   TON_WALLET_ADDRESS: ${process.env.TON_WALLET_ADDRESS ? process.env.TON_WALLET_ADDRESS.substring(0, 10) + '...' : 'не задано'}`);
console.log(`   ADMIN_SEED: ${process.env.ADMIN_SEED ? 'загружен (' + process.env.ADMIN_SEED.split(' ').length + ' слов)' : 'не задано'}`);
console.log(`   DEBUG_MODE: ${process.env.DEBUG_MODE || 'не задано'}`);
console.log(`   PORT: ${process.env.PORT || 'не задано'}`);

const path = require('path');
const { getHttpEndpoint } = require('@orbs-network/ton-access');

/**
 * Сервер для мультиплеерной игры "Змейка" (Telegram Mini App)
 * Node.js + Socket.io + lowdb
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const db = require('./db/database');
const { initUser, getUser, updateUser, buyGamesWithWinnings } = require('./db/users');
const { initializeDatabase } = require('./models/User');
const { migrateUsersFromJSON } = require('./db/migrate');
const { User } = require('./models/User');
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
  },
  // ОПТИМИЗАЦИЯ: Улучшенное сжатие WebSocket для уменьшения трафика
  transports: ['websocket', 'polling'],
  compression: true,
  // Более эффективное сжатие per-message deflate (экономия 60-80% трафика)
  perMessageDeflate: {
    zlibDeflateOptions: {
      chunkSize: 1024,
      memLevel: 7,
      level: 3 // Баланс между скоростью и степенью сжатия
    },
    zlibInflateOptions: {
      chunkSize: 1024,
      memLevel: 7
    },
    // Сжимать только сообщения больше 1024 байт
    threshold: 1024
  },
  maxHttpBufferSize: 1e6,
  // Оптимизация сетевого обмена: отключаем задержку Nagle для мгновенной отправки
  pingTimeout: 60000,
  pingInterval: 25000
});

// Включаем noDelay для всех TCP соединений (мгновенная отправка без буферизации)
io.engine.on('connection', (socket) => {
  if (socket.transport && socket.transport.socket && socket.transport.socket.setNoDelay) {
    socket.transport.socket.setNoDelay(true);
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
const lastWithdrawRequest = new Map(); // userId -> timestamp (защита от частых запросов)

// Конфигурация игры
const GAME_CONFIG = {
  FIELD_WIDTH: 30, // Увеличено с 20 до 30 (больше клеток для передвижения)
  FIELD_HEIGHT: 30, // Увеличено с 20 до 30
  TICK_RATE: 9, // тиков в секунду (замедлено в 2 раза: было 18, стало 9)
  ENTRY_PRICE: 1, // стоимость входа (в TON, списывается из winnings_ton)
  WINNER_PERCENTAGE: 0.75, // процент выигрыша победителя (75%)
  MAX_CONCURRENT_GAMES: 70 // лимит одновременных игр; при достижении новые пары ждут в очереди
};

// Инициализация базы данных
db.init().then(async () => {
  console.log('✅ База данных (lowdb) инициализирована');
  
  // Инициализация PostgreSQL (если DATABASE_URL задана)
  const pgInitialized = await initializeDatabase();
  
  if (pgInitialized) {
    // Миграция пользователей из JSON в PostgreSQL
    console.log('📋 Начинаем миграцию пользователей из JSON в PostgreSQL...');
    await migrateUsersFromJSON();
  } else {
    console.warn('⚠️ PostgreSQL не инициализирован, используется lowdb (JSON)');
  }
  
  // Инициализация файлов для TON платежей (если не DEBUG_MODE)
  if (!DEBUG_MODE) {
    await tonPayment.initPaymentFiles();
    
    // Используем значения из .env, с fallback на true для тестнета если не задано
    const IS_TESTNET = process.env.IS_TESTNET === 'true' || process.env.IS_TESTNET === true || process.env.IS_TESTNET === 'TRUE' || true; // Fallback: true (тестнет)
    const WALLET = process.env.TON_WALLET_ADDRESS || '';
    const API_KEY = process.env.TONCENTER_API_KEY || process.env.TON_API_KEY || ''; // Для сканера транзакций (пока используем TonCenter API)
    
    // Определяем, используются ли fallback значения
    const usingFallback = !process.env.IS_TESTNET || !process.env.TON_WALLET_ADDRESS;
    
    // Устанавливаем правильный API URL на основе IS_TESTNET (для сканера транзакций)
    const API_URL = IS_TESTNET ? 'https://testnet.toncenter.com/api/v2' : 'https://toncenter.com/api/v2';
    
    // Логирование конфигурации
    if (usingFallback) {
      const envPath = path.join(__dirname, '.env');
      console.warn(`⚠️ ВНИМАНИЕ: Файл .env не найден по пути ${envPath}. Используются ручные настройки для TESTNET.`);
      console.log(`✅ WALLET: ${WALLET.substring(0, 5)}...`);
      console.log(`✅ API_URL (для сканера): ${API_URL}`);
    }
    
    // Логирование переменных окружения для отладки
    console.log('🔍 Проверка переменных окружения:');
    console.log(`   process.env.IS_TESTNET = "${process.env.IS_TESTNET || 'undefined (используется fallback)'}" (type: ${typeof process.env.IS_TESTNET})`);
    console.log(`   process.env.TON_WALLET_ADDRESS = "${process.env.TON_WALLET_ADDRESS ? process.env.TON_WALLET_ADDRESS.substring(0, 10) + '...' : 'undefined (используется fallback)'}"`);
    
    console.log(`✅ ПРОВЕРКА: IS_TESTNET из файла = ${IS_TESTNET}${usingFallback ? ' (fallback)' : ''}`);
    
    // Инициализация конфигурации TON (для сканера транзакций пока используется TonCenter)
    tonPayment.initConfig({
      IS_TESTNET: IS_TESTNET,
      TON_WALLET_ADDRESS: WALLET,
      TON_API_KEY: API_KEY  // Для сканера транзакций (пока используем TonCenter API)
    });
    
    console.log(`🌐 TON Config: IS_TESTNET=${IS_TESTNET}, API_URL (для сканера)=${API_URL}`);

    // ОПТИМИЗАЦИЯ: Выносим сканер TON в отдельный интервал, который не пересекается с игровым циклом
    // Используем setImmediate для асинхронных операций, чтобы не блокировать event loop
    let scannerInterval = null;
    let isScanning = false; // Флаг для предотвращения параллельных запусков
    
    const runScanner = () => {
      // Пропускаем, если сканирование уже выполняется
      if (isScanning) {
        return;
      }
      
      // Запускаем сканер асинхронно, чтобы не блокировать основной поток
      setImmediate(async () => {
        isScanning = true;
        try {
          await tonPayment.checkTonPayments(io);
        } catch (error) {
          console.error('❌ Ошибка сканера транзакций:', error);
        } finally {
          isScanning = false;
        }
      });
    };
    
    // Первая проверка сразу после запуска (асинхронно)
    runScanner();
    
    // Периодическая проверка каждые 35 секунд (увеличено для предотвращения 429)
    // Используем отдельный интервал, который не пересекается с игровым циклом
    scannerInterval = setInterval(runScanner, 35000); // 35 секунд
    console.log('✅ Сканер блокчейна TON запущен (интервал: 35 сек, асинхронный режим, не блокирует event loop)');
  }
  
  // Запускаем игровой цикл (передаем endGame как callback)
  // Сообщение о запуске выводится внутри gameLoop.start(), убираем дублирование
  gameLoop.start(io, activeGames, GAME_CONFIG, endGame);
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

// Кэш для отслеживания недавних подключений (защита от частых переподключений)
const recentConnections = new Map(); // userId -> timestamp

io.on('connection', async (socket) => {
  const userId = socket.handshake.auth.user_id;
  const username = socket.handshake.auth.username || `User_${userId}`;
  
  // Проверка: если пользователь переподключается в течение 2 секунд, используем существующую сессию
  const lastConnection = recentConnections.get(userId);
  const now = Date.now();
  const reconnectThreshold = 2000; // 2 секунды
  
  if (lastConnection && (now - lastConnection) < reconnectThreshold) {
    console.log(`🔄 Быстрое переподключение игрока ${userId} (${now - lastConnection}ms). Используем существующую сессию.`);
  } else {
    console.log(`🔌 Пользователь подключен: ${userId} (${username})`);
    // Инициализация пользователя в БД только если не было недавнего подключения
    await initUser(userId, username, DEBUG_MODE);
  }
  
  // Обновляем время последнего подключения
  recentConnections.set(userId, now);
  
  // Очистка старых записей каждые 10 секунд (чтобы не накапливать память)
  if (recentConnections.size > 1000) {
    const tenSecondsAgo = now - 10000;
    for (const [uid, timestamp] of recentConnections.entries()) {
      if (timestamp < tenSecondsAgo) {
        recentConnections.delete(uid);
      }
    }
  }
  
  socketToUser.set(socket.id, userId);
  
  // Присоединяем к комнате пользователя для отправки событий payment_success
  socket.join(`user_${userId}`);
  
  // Отправляем информацию о режиме и балансе
  const user = await getUser(userId);
  socket.emit('user_data', {
    userId,
    username,
    games_balance: user.games_balance,
    winnings_ton: user.winnings_ton,
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
  
  // Обработка ping для измерения задержки сети
  socket.on('ping', (timestamp) => {
    socket.emit('pong', timestamp);
  });
  
  // Инициация депозита
  socket.on('initiateDeposit', async (data) => {
    try {
      if (DEBUG_MODE) {
        socket.emit('error', {
          message: 'TON deposits are only available in production mode (DEBUG_MODE=false)'
        });
        return;
      }

      const { amount } = data;
      
      if (!amount || amount <= 0) {
        socket.emit('error', {
          message: 'Invalid deposit amount. Amount must be greater than 0'
        });
        return;
      }

      const result = await tonPayment.createDeposit(userId, amount);
      
      if (result.success) {
        // Отправляем данные депозита клиенту
        socket.emit('deposit_initiated', result);
      } else {
        socket.emit('error', {
          message: result.error || 'Failed to create deposit'
        });
      }
    } catch (error) {
      socket.emit('error', {
        message: error.message || 'Error initiating deposit'
      });
    }
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
  
  // Обработчик покупки игр с выигрышного баланса (Реинвест)
  socket.on('buyGamesWithWinnings', async (data) => {
    try {
      const { amount = 1 } = data;
      
      if (!amount || amount <= 0 || !Number.isInteger(amount)) {
        socket.emit('buy_games_error', {
          message: 'Некорректное количество игр (должно быть целое число >= 1)'
        });
        return;
      }
      
      console.log(`📥 Запрос на покупку ${amount} игр за выигрыши от пользователя: ${userId}`);
      
      // ОПТИМИЗАЦИЯ: Получаем текущий баланс для мгновенного обновления UI
      const currentUser = await getUser(userId);
      
      // Проверка баланса выигрышей
      if (currentUser.winnings_ton < amount) {
        socket.emit('buy_games_error', {
          message: `Недостаточно выигрышей! Доступно: ${currentUser.winnings_ton.toFixed(2)} TON, требуется: ${amount} TON`
        });
        return;
      }
      
      // ОПТИМИЗАЦИЯ: Мгновенно отправляем обновленный баланс клиенту (локальный стейт)
      // Клиент увидит изменения сразу, не дожидаясь записи в БД
      const optimisticGamesBalance = currentUser.games_balance + amount;
      const optimisticWinningsTon = currentUser.winnings_ton - amount;
      
      socket.emit('buy_games_success', {
        games_purchased: amount,
        games_balance: optimisticGamesBalance,
        winnings_ton: optimisticWinningsTon
      });
      
      console.log(`✅ Мгновенное обновление баланса отправлено игроку ${userId} (оптимистичное обновление)`);
      
      // ОПТИМИЗАЦИЯ: Запись в БД выполняется фоном (не блокирует ответ клиенту)
      setImmediate(async () => {
        try {
          const result = await buyGamesWithWinnings(userId, amount);
          
          if (result.success) {
            // Отправляем финальное подтверждение с актуальными данными из БД
            socket.emit('buy_games_confirmed', {
              games_purchased: result.gamesPurchased,
              games_balance: result.user.games_balance,
              winnings_ton: result.user.winnings_ton
            });
            
            console.log(`✅ Игрок ${userId} успешно купил ${result.gamesPurchased} игр за выигрыши (БД обновлена)`);
          } else {
            // Если запись в БД не удалась, отправляем ошибку и откатываем оптимистичное обновление
            socket.emit('buy_games_error', {
              message: result.error || 'Ошибка при покупке игр',
              rollback: true,
              games_balance: currentUser.games_balance,
              winnings_ton: currentUser.winnings_ton
            });
            
            console.log(`❌ Ошибка покупки игр для игрока ${userId}: ${result.error}`);
          }
        } catch (error) {
          console.error(`❌ Ошибка при покупке игр за выигрыши (фоновая запись):`, error);
          // Откатываем оптимистичное обновление
          socket.emit('buy_games_error', {
            message: error.message || 'Ошибка при покупке игр',
            rollback: true,
            games_balance: currentUser.games_balance,
            winnings_ton: currentUser.winnings_ton
          });
        }
      });
    } catch (error) {
      console.error(`❌ Ошибка при покупке игр за выигрыши:`, error);
      socket.emit('buy_games_error', {
        message: error.message || 'Ошибка при покупке игр'
      });
    }
  });
  
  // Обработчик запроса на вывод средств
  socket.on('requestWithdraw', async (data) => {
    console.log('📥 Получен запрос на вывод от пользователя:', userId);
    console.log('   Данные запроса:', data);
    
    try {
      const { amount, address } = data;
      
      if (!amount || amount <= 0) {
        socket.emit('withdrawal_error', {
          message: 'Некорректная сумма для вывода'
        });
        return;
      }
      
      // Защита от частых запросов (30 секунд)
      const lastRequest = lastWithdrawRequest.get(userId);
      const now = Date.now();
      if (lastRequest && (now - lastRequest) < 30000) {
        const remainingSeconds = Math.ceil((30000 - (now - lastRequest)) / 1000);
        socket.emit('withdrawal_error', {
          message: `Пожалуйста, подождите ${remainingSeconds} секунд перед следующим запросом вывода`
        });
        return;
      }
      
      // Получаем пользователя
      const user = await getUser(userId);
      console.log('1. Проверка баланса пройдена:', { winnings_ton: user.winnings_ton, requested: amount });
      
      // Проверяем баланс
      if (!user.winnings_ton || user.winnings_ton < amount) {
        socket.emit('withdrawal_error', {
          message: `Недостаточно средств для вывода. Доступно: ${user.winnings_ton || 0} TON, запрошено: ${amount} TON`
        });
        return;
      }
      
      // Минимальная сумма вывода 1.75 TON
      if (amount < 1.75) {
        socket.emit('withdrawal_error', {
          message: 'Минимальная сумма вывода: 1.75 TON'
        });
        return;
      }
      
      // АНТИ-ФРОД ПРОВЕРКИ
      // 1. Проверка лимита адекватности: сумма вывода не должна превышать максимально возможный заработок
      const maxPossibleEarnings = (user.totalEarned || 0); // Максимум = общий заработок
      if (amount > maxPossibleEarnings) {
        console.error(`⚠️ ПОДОЗРЕНИЕ НА ВЗЛОМ БАЛАНСА: Игрок ${userId}. Запрошено: ${amount}, максимум возможный: ${maxPossibleEarnings}`);
        socket.emit('withdrawal_error', {
          message: 'Ошибка проверки баланса. Пожалуйста, обратитесь в поддержку.'
        });
        return;
      }
      
      // 2. Проверка: winnings_ton не должен превышать totalEarned (допускаем небольшую погрешность для округления)
      const winningsDiff = (user.winnings_ton || 0) - (user.totalEarned || 0);
      if (winningsDiff > 0.01) { // Допускаем погрешность 0.01 TON
        console.error(`⚠️ ПОДОЗРЕНИЕ НА ВЗЛОМ БАЛАНСА: Игрок ${userId}. winnings_ton (${user.winnings_ton}) > totalEarned (${user.totalEarned})`);
        socket.emit('withdrawal_error', {
          message: 'Ошибка проверки баланса. Пожалуйста, обратитесь в поддержку.'
        });
        return;
      }
      
      // 3. Проверка количества побед: максимальная сумма = количество побед * 1.75
      const expectedWinningsPerWin = 1.75;
      const maxWinningsByWins = (user.totalEarned || 0) / expectedWinningsPerWin * expectedWinningsPerWin;
      if (amount > maxWinningsByWins + 0.01) {
        console.error(`⚠️ ПОДОЗРЕНИЕ НА ВЗЛОМ БАЛАНСА: Игрок ${userId}. Сумма вывода (${amount}) превышает возможную по количеству побед (${maxWinningsByWins})`);
        socket.emit('withdrawal_error', {
          message: 'Ошибка проверки баланса. Пожалуйста, обратитесь в поддержку.'
        });
        return;
      }
      
      console.log('✅ Анти-фрод проверки пройдены:', {
        totalEarned: user.totalEarned,
        winnings_ton: user.winnings_ton,
        requested: amount,
        maxPossibleEarnings
      });
      
      // Используем адрес из запроса или из БД
      const userWallet = (address && address.trim()) || user.wallet || user.wallet_address || '';
      if (!userWallet || userWallet.trim() === '') {
        console.log('❌ Кошелек не найден в запросе и в БД:', { address, wallet: user.wallet, wallet_address: user.wallet_address });
        socket.emit('withdrawal_error', {
          message: 'Кошелек не указан. Пожалуйста, укажите адрес кошелька.'
        });
        return;
      }
      console.log('2. Кошелек найден:', userWallet);
      console.log('   Источник адреса:', address ? 'из запроса' : (user.wallet ? 'из БД (wallet)' : 'из БД (wallet_address)'));
      console.log('   Длина адреса:', userWallet.length);
      console.log('   Формат адреса:', userWallet.includes('_') ? 'url-safe (с подчеркиваниями)' : 'standard (без подчеркиваний)');
      
      // Обновляем время последнего запроса
      lastWithdrawRequest.set(userId, now);
      
      // БЕЗОПАСНЫЙ ВЫВОД: Проверяем ADMIN_SEED ПЕРЕД списанием баланса
      const adminSeed = process.env.ADMIN_SEED;
      console.log('🔍 Проверка ADMIN_SEED:', !!adminSeed, adminSeed ? '(загружен)' : '(не найден)');
      
      if (!adminSeed && !DEBUG_MODE) {
        // Если нет ADMIN_SEED и не DEBUG_MODE - выдаем ошибку и НЕ списываем баланс
        socket.emit('withdrawal_error', {
          message: 'Система вывода временно недоступна. Пожалуйста, попробуйте позже.'
        });
        console.error('❌ ADMIN_SEED не найден, вывод отменен без списания баланса');
        return;
      }
      
      // Курс 1:1 (1 TON = 1 TON)
      const amountInTon = parseFloat(amount);
      
      let txHash = null;
      let withdrawalStatus = 'pending';
      let transactionSuccess = false;
      let errorDetails = ''; // Детали ошибки для передачи клиенту
      
      // Попытка реального вывода через TON API
      try {
        console.log(`🔍 [Withdrawal] Начало обработки: adminSeed=${!!adminSeed}, DEBUG_MODE=${DEBUG_MODE}`);
        
        if (adminSeed && !DEBUG_MODE) {
          // Реальная транзакция через @ton/ton (требуется: npm install @ton/ton @ton/crypto)
          try {
            console.log(`📦 [Withdrawal] Загрузка TON SDK...`);
            const { TonClient, WalletContractV4, WalletContractV3R2, internal, toNano, Address } = require('@ton/ton');
            const { mnemonicToWalletKey } = require('@ton/crypto');
            
            // Используем децентрализованный Orbs Access вместо TonCenter
            // ВАЖНО: Используем ту же логику, что и для сканера (с fallback на testnet)
            const isTestnet = process.env.IS_TESTNET === 'true' || process.env.IS_TESTNET === true || process.env.IS_TESTNET === 'TRUE' || true; // Fallback: true (тестнет)
            console.log(`🌐 [Withdrawal] IS_TESTNET=${isTestnet} (из env: ${process.env.IS_TESTNET || 'undefined (fallback=true)'}), network=${isTestnet ? 'testnet' : 'mainnet'}`);
            console.log(`⏳ [Withdrawal] Начинаем получение endpoint...`);
            
            // Получаем endpoint через децентрализованную сеть Orbs с таймаутом
            console.log(`🔗 [Withdrawal] Получение endpoint через Orbs Access для сети: ${isTestnet ? 'testnet' : 'mainnet'}...`);
            let endpoint;
            try {
              // Добавляем таймаут для получения endpoint (10 секунд)
              const endpointPromise = getHttpEndpoint({ network: isTestnet ? 'testnet' : 'mainnet' });
              const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Timeout: получение endpoint заняло более 10 секунд')), 10000)
              );
              
              endpoint = await Promise.race([endpointPromise, timeoutPromise]);
              console.log(`✅ [Withdrawal] Подключено к децентрализованному узлу: ${endpoint}`);
            } catch (endpointError) {
              console.error(`❌ [Withdrawal] Ошибка получения endpoint через Orbs:`, endpointError.message);
              console.error(`❌ [Withdrawal] Stack:`, endpointError.stack);
              
              // Fallback: используем прямой endpoint TonCenter
              console.log(`🔄 [Withdrawal] Используем fallback: прямой endpoint TonCenter...`);
              endpoint = isTestnet 
                ? 'https://testnet.toncenter.com/api/v2/jsonRPC'
                : 'https://toncenter.com/api/v2/jsonRPC';
              console.log(`✅ [Withdrawal] Используется fallback endpoint: ${endpoint}`);
              console.log(`⏭️ [Withdrawal] Продолжаем выполнение после fallback...`);
            }
              
            // API-ключ TonCenter увеличивает лимит запросов (снижает вероятность 429)
            const apiKey = process.env.TONCENTER_API_KEY || process.env.TON_API_KEY || '';
            if (apiKey) {
              console.log(`🔑 [Withdrawal] Используется TonCenter API Key (увеличенный rate limit)`);
            } else {
              console.log(`⚠️ [Withdrawal] TonCenter API Key не задан — возможны ограничения (429). Получить ключ: @toncenter в Telegram или https://docs.ton.org/ecosystem/api/toncenter/get-api-key`);
            }
            
            console.log(`🔧 [Withdrawal] Создание TonClient с endpoint: ${endpoint}`);
            const client = new TonClient({ endpoint, apiKey: apiKey || undefined });
            console.log(`✅ [Withdrawal] TonClient создан успешно`);
            
            // Создаем кошелек из seed-фразы
            console.log(`🔑 [Withdrawal] Создание кошелька из seed-фразы...`);
            const seedWords = adminSeed.split(' ');
            if (seedWords.length !== 24) {
              errorDetails = 'ADMIN_SEED должен содержать 24 слова';
              throw new Error(errorDetails);
            }
            
            let keyPair;
            try {
              keyPair = await mnemonicToWalletKey(seedWords);
              console.log(`✅ [Withdrawal] KeyPair создан`);
            } catch (keyError) {
              console.error(`❌ [Withdrawal] Ошибка создания KeyPair:`, keyError.message);
              errorDetails = `Ошибка создания ключа из seed-фразы: ${keyError.message}`;
              throw new Error(errorDetails);
            }
            
            const opts = { testOnly: isTestnet, bounceable: false, urlSafe: true };
            const walletV4 = WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 });
            const walletV3R2 = WalletContractV3R2.create({ publicKey: keyPair.publicKey, workchain: 0 });
            const addrV4 = walletV4.address.toString(opts);
            const addrV3R2 = walletV3R2.address.toString(opts);
            console.log(`📝 [Withdrawal] Адрес V4 (из seed):    ${addrV4}`);
            console.log(`📝 [Withdrawal] Адрес V3R2 (из seed): ${addrV3R2}`);

            const expectedAddrRaw = (process.env.TON_WALLET_ADDRESS || '').trim();
            let wallet = null;
            let walletVersion = '';

            if (expectedAddrRaw) {
              let expectedNorm;
              try {
                expectedNorm = Address.parse(expectedAddrRaw).toString(opts);
              } catch (parseErr) {
                errorDetails = `Некорректный TON_WALLET_ADDRESS: ${parseErr.message}`;
                throw new Error(errorDetails);
              }
              if (addrV4 === expectedNorm) {
                wallet = walletV4;
                walletVersion = 'V4';
                console.log(`✅ [Withdrawal] Используем V4: адрес совпадает с TON_WALLET_ADDRESS`);
              } else if (addrV3R2 === expectedNorm) {
                wallet = walletV3R2;
                walletVersion = 'V3R2';
                console.log(`✅ [Withdrawal] Используем V3R2: адрес совпадает с TON_WALLET_ADDRESS`);
              } else {
                errorDetails = `Адрес TON_WALLET_ADDRESS (${expectedAddrRaw}) не совпадает ни с V4 (${addrV4}), ни с V3R2 (${addrV3R2}) из ADMIN_SEED. Проверьте, что seed соответствует этому кошельку.`;
                throw new Error(errorDetails);
              }
            }

            if (!wallet) {
              let balV4 = BigInt(0);
              let balV3 = BigInt(0);
              try {
                balV4 = await client.getBalance(walletV4.address);
                console.log(`💰 [Withdrawal] Баланс V4: ${balV4.toString()} нанотонов`);
              } catch (e) {
                console.warn(`⚠️ [Withdrawal] Ошибка getBalance V4:`, e.message);
              }
              try {
                balV3 = await client.getBalance(walletV3R2.address);
                console.log(`💰 [Withdrawal] Баланс V3R2: ${balV3.toString()} нанотонов`);
              } catch (e) {
                console.warn(`⚠️ [Withdrawal] Ошибка getBalance V3R2:`, e.message);
              }
              const requiredNano = BigInt(Math.ceil((amountInTon + 0.1) * 1e9));
              if (balV4 >= requiredNano) {
                wallet = walletV4;
                walletVersion = 'V4';
                console.log(`✅ [Withdrawal] Используем V4: достаточно баланса`);
              } else if (balV3 >= requiredNano) {
                wallet = walletV3R2;
                walletVersion = 'V3R2';
                console.log(`✅ [Withdrawal] Используем V3R2: достаточно баланса`);
              } else {
                const balanceV4Ton = Number(balV4) / 1e9;
                const balanceV3Ton = Number(balV3) / 1e9;
                errorDetails = `Недостаточно средств на кошельке админа. V4: ${balanceV4Ton.toFixed(4)} TON, V3R2: ${balanceV3Ton.toFixed(4)} TON; требуется ${(amountInTon + 0.1).toFixed(4)} TON (сумма + 0.1 комиссия). Убедитесь, что TON_WALLET_ADDRESS соответствует кошельку из ADMIN_SEED (V4 или V3R2).`;
                throw new Error(errorDetails);
              }
            }

            const walletAddress = wallet.address.toString(opts);
            console.log(`📝 [Withdrawal] Выбран кошелёк ${walletVersion}: ${walletAddress}`);

            let balance;
            try {
              balance = await client.getBalance(wallet.address);
              console.log(`✅ [Withdrawal] Баланс получен: ${balance.toString()} нанотонов`);
            } catch (balanceError) {
              console.error('❌ [Withdrawal] Ошибка getBalance:', balanceError.message);
              errorDetails = `Ошибка проверки баланса: ${balanceError.message}`;
              throw balanceError;
            }

            const balanceInTon = parseFloat(balance.toString()) / 1000000000;
            console.log(`💰 [Withdrawal] Баланс админа: ${balanceInTon.toFixed(4)} TON, требуется: ${(amountInTon + 0.1).toFixed(4)} TON`);

            if (balanceInTon < amountInTon + 0.1) {
              const required = amountInTon + 0.1;
              errorDetails = `Недостаточно средств на администраторском кошельке. Баланс: ${balanceInTon.toFixed(4)} TON, требуется: ${required.toFixed(4)} TON (${amountInTon} TON + 0.1 TON комиссия)`;
              throw new Error(errorDetails);
            }

            // Используем выбранный кошелёк (V4 или V3R2)
            console.log(`🚀 [Withdrawal] Подготовка транзакции...`);
            try {
              const provider = client.provider(wallet.address);
              console.log(`✅ [Withdrawal] Provider создан`);
              
              // Функция для получения seqno с retry при ошибке 429
              const getSeqnoWithRetry = async (maxRetries = 5, initialDelayMs = 3000) => {
                for (let attempt = 1; attempt <= maxRetries; attempt++) {
                  try {
                    const seqno = await wallet.getSeqno(provider);
                    return seqno;
                  } catch (error) {
                    const isRateLimit = error.message && (
                      error.message.includes('429') || 
                      error.message.includes('Too Many Requests') ||
                      error.status === 429 ||
                      error.response?.status === 429
                    );
                    
                    if (isRateLimit && attempt < maxRetries) {
                      // Экспоненциальная задержка: 3s, 6s, 12s, 24s
                      const waitTime = initialDelayMs * Math.pow(2, attempt - 1);
                      console.log(`⚠️ [Withdrawal] Rate limit (429) при получении seqno, попытка ${attempt}/${maxRetries}. Ждём ${waitTime}ms (${(waitTime/1000).toFixed(1)}s)...`);
                      await new Promise(resolve => setTimeout(resolve, waitTime));
                      continue;
                    }
                    throw error;
                  }
                }
              };
              
              const seqno = await getSeqnoWithRetry();
              console.log(`✅ [Withdrawal] Seqno получен: ${String(seqno)}`);
              
              // Конвертируем адрес получателя
              console.log(`📝 [Withdrawal] Парсинг адреса получателя: ${userWallet}`);
              console.log(`📝 [Withdrawal] Длина адреса: ${userWallet.length}, формат: ${userWallet.includes('_') ? 'url-safe' : 'standard'}`);
              let recipientAddress;
              try {
                recipientAddress = Address.parse(userWallet);
                const recipientAddrStr = recipientAddress.toString({ 
                  testOnly: isTestnet, 
                  bounceable: false, 
                  urlSafe: true 
                });
                console.log(`✅ [Withdrawal] Адрес получателя распарсен успешно`);
                console.log(`📝 [Withdrawal] Нормализованный адрес получателя: ${recipientAddrStr}`);
                console.log(`📝 [Withdrawal] Workchain получателя: ${recipientAddress.workChain}`);
                
                // Проверяем, что адрес получателя не совпадает с адресом отправителя (защита от ошибок)
                if (recipientAddress.equals(wallet.address)) {
                  console.warn(`⚠️ [Withdrawal] Адрес получателя совпадает с адресом отправителя!`);
                  errorDetails = 'Адрес получателя не может совпадать с адресом администратора';
                  throw new Error(errorDetails);
                }
              } catch (parseError) {
                console.error(`❌ [Withdrawal] Ошибка парсинга адреса получателя:`, parseError.message);
                console.error(`❌ [Withdrawal] Полный адрес: ${userWallet}`);
                console.error(`❌ [Withdrawal] Stack:`, parseError.stack);
                errorDetails = `Некорректный адрес кошелька получателя: ${parseError.message}. Убедитесь, что адрес указан правильно и соответствует сети (${isTestnet ? 'testnet' : 'mainnet'}).`;
                throw new Error(errorDetails);
              }
              
              const amountInNano = toNano(amountInTon.toFixed(9));
              console.log(`💰 [Withdrawal] Сумма: ${amountInTon} TON = ${amountInNano.toString()} нанотонов`);
              console.log(`🚀 [Withdrawal] Отправка транзакции: seqno=${String(seqno)}, сумма=${amountInTon} TON, получатель=${recipientAddress.toString()}`);
              
              // Функция для отправки транзакции с retry при ошибке 429
              const sendTransferWithRetry = async (currentSeqno, maxRetries = 5, initialDelayMs = 3000) => {
                let attemptSeqno = currentSeqno;
                for (let attempt = 1; attempt <= maxRetries; attempt++) {
                  try {
                    await wallet.sendTransfer(provider, {
                      seqno: attemptSeqno,
                      secretKey: keyPair.secretKey,
                      messages: [
                        internal({
                          to: recipientAddress,
                          value: amountInNano,
                          bounce: false,
                          body: `Snake Game Prize: ${amount} TON`
                        })
                      ]
                    });
                    return; // Успешно отправлено
                  } catch (error) {
                    const isRateLimit = error.message && (
                      error.message.includes('429') || 
                      error.message.includes('Too Many Requests') ||
                      error.status === 429 ||
                      error.response?.status === 429
                    );
                    
                    if (isRateLimit && attempt < maxRetries) {
                      // Экспоненциальная задержка: 3s, 6s, 12s, 24s
                      const waitTime = initialDelayMs * Math.pow(2, attempt - 1);
                      console.log(`⚠️ [Withdrawal] Rate limit (429) при отправке транзакции, попытка ${attempt}/${maxRetries}. Ждём ${waitTime}ms (${(waitTime/1000).toFixed(1)}s)...`);
                      await new Promise(resolve => setTimeout(resolve, waitTime));
                      // Обновляем seqno перед повторной попыткой (с меньшим количеством retry, чтобы не усугублять проблему)
                      try {
                        attemptSeqno = await getSeqnoWithRetry(3, 2000);
                        console.log(`🔄 [Withdrawal] Seqno обновлён для повторной попытки: ${String(attemptSeqno)}`);
                      } catch (seqnoError) {
                        console.warn(`⚠️ [Withdrawal] Не удалось обновить seqno, используем предыдущий: ${String(attemptSeqno)}`);
                      }
                      continue;
                    }
                    throw error;
                  }
                }
              };
              
              await sendTransferWithRetry(seqno);
              
              console.log('✅ [Withdrawal] Транзакция успешно отправлена в сеть!');
              transactionSuccess = true;
              withdrawalStatus = 'completed';
              txHash = `tx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            } catch (e) {
              console.error('❌ [Withdrawal] Ошибка при отправке через sendTransfer:', e.message);
              console.error('❌ [Withdrawal] Stack:', e.stack);
              transactionSuccess = false;
              txHash = `withdraw_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
              withdrawalStatus = 'failed';
              
              // Проверяем, является ли это ошибкой rate limit
              const isRateLimit = e.message && (
                e.message.includes('429') || 
                e.message.includes('Too Many Requests') ||
                e.status === 429 ||
                e.response?.status === 429
              );
              
              if (isRateLimit) {
                errorDetails = 'Сеть TON временно перегружена (rate limit). Все попытки отправки исчерпаны. Пожалуйста, попробуйте через несколько минут. Баланс не списан.';
              } else {
                errorDetails = `Ошибка отправки транзакции: ${e.message}`;
              }
            }
          } catch (tonError) {
            console.error('❌ [Withdrawal] Ошибка TON SDK:', tonError.message);
            console.error('❌ [Withdrawal] Stack:', tonError.stack);
            transactionSuccess = false;
            txHash = `withdraw_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            withdrawalStatus = 'failed';
            errorDetails = `Ошибка TON SDK: ${tonError.message}`;
          }
        } else if (DEBUG_MODE) {
          // DEBUG_MODE: симулируем успешную транзакцию
          console.log(`💰 [Withdrawal] Вывод средств (DEBUG_MODE): ${amount} TON на ${userWallet}`);
          transactionSuccess = true;
          txHash = `debug_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          withdrawalStatus = 'completed';
        } else {
          // Нет ADMIN_SEED и не DEBUG_MODE - уже обработано выше
          console.warn(`⚠️ [Withdrawal] Нет ADMIN_SEED и не DEBUG_MODE, транзакция не отправлена`);
          transactionSuccess = false;
          withdrawalStatus = 'failed';
          errorDetails = 'Система вывода временно недоступна. ADMIN_SEED не настроен.';
        }
      } catch (error) {
        console.error('❌ [Withdrawal] Ошибка при выполнении TON транзакции:', error.message);
        console.error('❌ [Withdrawal] Stack:', error.stack);
        transactionSuccess = false;
        txHash = `withdraw_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        withdrawalStatus = 'failed';
        if (!errorDetails) {
          errorDetails = `Ошибка выполнения транзакции: ${error.message}`;
        }
      }
      
      // БЕЗОПАСНЫЙ ВЫВОД: Списываем баланс ТОЛЬКО после успешной отправки транзакции
      if (transactionSuccess) {
        const newWinnings = Math.max(0, (user.winnings_ton || 0) - amount);
        await updateUser(userId, {
          winnings_ton: newWinnings
        });
        console.log('💰 [Withdrawal] Баланс списан ПОСЛЕ успешной отправки транзакции:', { 
          old: user.winnings_ton, 
          new: newWinnings 
        });
      } else {
        // Транзакция не удалась - баланс НЕ списываем
        console.warn('⚠️ [Withdrawal] Транзакция не удалась, баланс НЕ списан');
        console.warn('⚠️ [Withdrawal] Причина: transactionSuccess=false, withdrawalStatus=' + withdrawalStatus);
        console.warn('⚠️ [Withdrawal] Детали ошибки:', errorDetails || 'Неизвестная ошибка');
        
        // Формируем понятное сообщение для пользователя
        let userMessage = 'Не удалось отправить транзакцию. Баланс не списан.';
        if (errorDetails) {
          // Если есть детали, добавляем их (но упрощаем для пользователя)
          if (errorDetails.includes('ADMIN_SEED')) {
            userMessage = 'Система вывода временно недоступна. Попробуйте позже.';
          } else if (errorDetails.includes('Недостаточно средств')) {
            userMessage = 'Недостаточно средств на администраторском кошельке. Обратитесь в поддержку.';
          } else if (errorDetails.includes('Некорректный адрес')) {
            userMessage = 'Некорректный адрес кошелька. Проверьте адрес и попробуйте снова.';
          } else if (errorDetails.includes('подключиться к TON сети')) {
            userMessage = 'Ошибка подключения к сети TON. Попробуйте позже.';
          } else if (errorDetails.includes('rate limit') || errorDetails.includes('перегружена')) {
            userMessage = 'Сеть TON временно перегружена. Пожалуйста, попробуйте через несколько минут. Баланс не списан.';
          } else {
            userMessage = `Ошибка: ${errorDetails}`;
          }
        }
        
        socket.emit('withdrawal_error', {
          message: userMessage
        });
        return;
      }
      
      // Логируем вывод в withdrawals.json (асинхронно, чтобы не блокировать)
      const fs = require('fs').promises;
      const withdrawalsPath = path.join(__dirname, 'withdrawals.json');
      
      // Выполняем асинхронно через setImmediate для неблокирующего выполнения
      setImmediate(async () => {
        try {
          let withdrawals = {};
          try {
            const data = await fs.readFile(withdrawalsPath, 'utf8');
            withdrawals = JSON.parse(data);
          } catch {
            withdrawals = {};
          }
          
          const withdrawalId = `withdrawal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          // Используем адрес из запроса или из БД
          const recipientWalletFinal = userWallet;
          withdrawals[withdrawalId] = {
            userId,
            amount,
            amountInTon,
            wallet: recipientWalletFinal,
            txHash,
            status: withdrawalStatus,
            createdAt: Date.now()
          };
          
          await fs.writeFile(withdrawalsPath, JSON.stringify(withdrawals, null, 2), 'utf8');
        } catch (error) {
          console.error('❌ Ошибка записи withdrawals.json:', error);
        }
      });
      
      // Отправляем успешный ответ
      const updatedUser = await getUser(userId);
      socket.emit('withdrawal_success', {
        amount,
        txHash,
        games_balance: updatedUser.games_balance,
        winnings_ton: updatedUser.winnings_ton
      });
      
    } catch (error) {
      console.error('❌ Ошибка при выводе средств:', error);
      socket.emit('withdrawal_error', {
        message: error.message || 'Неизвестная ошибка при выводе средств'
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
  // Проверяем баланс выигрышей (1 TON требуется для игры)
  const user = await getUser(userId);
  if (!user.winnings_ton || user.winnings_ton < 1) {
    socket.emit('error', {
      message: `Insufficient balance! Available: ${(user.winnings_ton || 0).toFixed(2)} TON, required: 1 TON`
    });
    return;
  }
  
  // Списываем 1 TON из выигрышей сразу при поиске
  const newWinnings = Math.max(0, (user.winnings_ton || 0) - 1);
  await updateUser(userId, {
    winnings_ton: newWinnings
  });
  
  // Отправляем обновленный баланс
  const updatedUser = await getUser(userId);
  socket.emit('balance_updated', {
    games_balance: updatedUser.games_balance,
    winnings_ton: updatedUser.winnings_ton
  });
  
  // Проверяем, не находится ли игрок уже в игре
  if (playerToGame.has(userId)) {
    socket.emit('error', { message: 'You are already in a game!' });
    return;
  }
  
  // Ищем ожидающего соперника
  const waitingUser = Array.from(waitingPlayers.keys()).find(id => id !== userId);
  const atLimit = activeGames.size >= GAME_CONFIG.MAX_CONCURRENT_GAMES;

  if (waitingUser) {
    if (atLimit) {
      // Лимит достигнут — не создаём игру, оба ждут в очереди
      waitingPlayers.set(userId, { socketId: socket.id, ready: false });
      socket.emit('waiting_opponent');
      console.log(`⏳ Игрок ${userId} в очереди (лимит ${GAME_CONFIG.MAX_CONCURRENT_GAMES} игр), ожидает с ${waitingUser}`);
      return;
    }
    // Найден соперник и есть слот — создаем игру
    const opponentSocketId = waitingPlayers.get(waitingUser).socketId;
    waitingPlayers.delete(waitingUser);

    await createGame(userId, waitingUser, socket.id, opponentSocketId);
  } else {
    // Нет соперника — добавляем в очередь ожидания
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
      socket.emit('error', { message: 'You are not in a game or in queue!' });
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
  // ОПТИМИЗАЦИЯ: Параллельные запросы к БД для уменьшения задержки
  const [player1, player2] = await Promise.all([
    getUser(player1Id),
    getUser(player2Id)
  ]);
  
  // Баланс уже списан при поиске матча, просто создаем игру
  const player1Socket = io.sockets.sockets.get(socket1Id);
  const player2Socket = io.sockets.sockets.get(socket2Id);
  
  // Отправляем актуальный баланс клиентам
  player1Socket?.emit('balance_updated', {
    games_balance: player1.games_balance,
    winnings_ton: player1.winnings_ton
  });
  player2Socket?.emit('balance_updated', {
    games_balance: player2.games_balance,
    winnings_ton: player2.winnings_ton
  });
  
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
  
  // Сбрасываем переменную отсчета при каждом новом старте (важно для предотвращения наложения)
  let count = 3; // Уменьшено с 5 до 3 секунд для быстрого старта
  
  // Очищаем предыдущий интервал, если он существует (защита от дублирования)
  if (game.countdownInterval) {
    clearInterval(game.countdownInterval);
  }
  
  const countdownInterval = setInterval(() => {
    // Отправляем событие countdown всем игрокам в комнате
    if (count > 0) {
      io.to(`game_${gameId}`).emit('countdown', {
        number: count,
        gameId
      });
      count--;
    } else {
      // Когда count становится 0, завершаем countdown и начинаем игру
      clearInterval(countdownInterval);
      game.countdownInterval = null; // Очищаем ссылку
      // Countdown завершен - начинаем игру
      startGame(gameId);
    }
  }, 1000);
  
  // Сохраняем ссылку на интервал в объекте игры для возможности очистки
  game.countdownInterval = countdownInterval;
}

/**
 * Запуск игры (после countdown)
 */
async function startGame(gameId) {
  const game = activeGames.get(gameId);
  if (!game) {
    console.error(`❌ Игра ${gameId} не найдена в activeGames!`);
    return;
  }
  
  // Проверяем, что змейки инициализированы корректно
  if (!game.snake1 || !game.snake1.body || game.snake1.body.length === 0) {
    console.error(`❌ Ошибка: snake1 не инициализирована в игре ${gameId}`);
  }
  if (!game.snake2 || !game.snake2.body || game.snake2.body.length === 0) {
    console.error(`❌ Ошибка: snake2 не инициализирована в игре ${gameId}`);
  }
  
  game.is_running = true;
  game.start_time = Date.now();
  
  // Получаем комнату игры для отправки initial_state
  const room = io.sockets.adapter.rooms.get(`game_${gameId}`);
  if (!room) {
    console.error(`❌ Комната game_${gameId} не найдена!`);
  } else {
    console.log(`📤 Отправляю состояние игры для комнаты: game_${gameId} (игроков: ${room.size})`);
  }
  
  // Отправляем начальное состояние каждому игроку
  room?.forEach(socketId => {
    const socket = io.sockets.sockets.get(socketId);
    if (socket) {
      const playerNumber = socket.playerNumber;
      const snapshot = gameLogic.getGameSnapshot(game, playerNumber === 1 ? game.player1_id : game.player2_id);
      
      socket.emit('game_start', {
        gameId,
        start_time: game.start_time,
        initial_state: snapshot // Добавляем initial_state для корректной отрисовки
      });
    }
  });
  
  console.log(`🚀 Игра ${gameId} началась! Змейки: snake1=${game.snake1?.body?.length || 0} сегментов, snake2=${game.snake2?.body?.length || 0} сегментов`);
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
    // Используем сохраненный prize из game.prize (если был установлен)
    if (!game.end_event_sent) {
      const roomName = `game_${gameId}`;
      const savedPrize = game.prize !== undefined ? game.prize : 0;
      io.to(roomName).emit('game_end', {
        winnerId,
        prize: savedPrize, // Используем сохраненный prize
        game_stats: {
          duration: game.end_time - game.start_time,
          pool: savedPrize > 0 ? GAME_CONFIG.ENTRY_PRICE * 2 : 0
        }
      });
      game.end_event_sent = true;
    }
    return;
  }
  
  // Фиксированная сумма выигрыша
  const winAmount = 1.75;
  let prize = 0; // По умолчанию приз = 0
  
  // Начисляем приз победителю
  if (winnerId) {
    // Проверка активности матча: выигрыш начисляется только если был хотя бы один тик
    if (game.tick_number === 0 || !game.tick_number) {
      console.log(`⚠️ Игра ${gameId} не имела тиков движения (tick_number=0). Выигрыш не начисляется.`);
      prize = 0;
    } else {
      try {
        // Получаем пользователя через Sequelize
        const winnerModel = await User.findByPk(winnerId.toString());
        
        // Проверяем, что это не бот (боты не имеют записи в БД)
        // Начисляем выигрыш только реальному игроку
        if (winnerModel) {
          // Получаем текущие значения
          const oldWinnings = winnerModel.winningsTon || 0;
          const oldTotalEarned = winnerModel.totalEarned || 0;
          
          // Начисляем выигрыш напрямую в базу через increment
          await winnerModel.increment('winningsTon', { by: winAmount });
          await winnerModel.increment('totalEarned', { by: winAmount });
          
          // Обновляем модель после increment
          await winnerModel.reload();
          
          prize = winAmount;
          
          // Жирное логирование начисления
          console.log('\n========================================');
          console.log(`💰 ВЫИГРЫШ ЗАЧИСЛЕН: Игрок ${winnerId}, новый баланс: ${winnerModel.winningsTon} TON`);
          console.log(`   withdrawalBalance (winnings_ton): ${oldWinnings} -> ${winnerModel.winningsTon} TON`);
          console.log(`   totalEarned: ${oldTotalEarned} -> ${winnerModel.totalEarned} TON`);
          console.log('========================================\n');
          
          // Получаем обновленного пользователя для отправки
          const updatedUser = await getUser(winnerId);
          
          // Сразу отправляем обновленный баланс игроку через Socket.io
          io.to(`user_${winnerId}`).emit('balance_updated', {
            games_balance: updatedUser.games_balance,
            winnings_ton: updatedUser.winnings_ton
          });
          
          // Дополнительное событие для обновления баланса
          io.to(`user_${winnerId}`).emit('updateBalance', winAmount);
          
          console.log(`📤 Отправлен обновленный баланс игроку ${winnerId}: winnings=${updatedUser.winnings_ton} TON`);
        } else {
          console.log(`⚠️ Победитель ${winnerId} не найден в PostgreSQL. Попытка через getUser...`);
          // Попытка получить через getUser (fallback на JSON если используется)
          try {
            const winner = await getUser(winnerId);
            
            if (winner && winner.tg_id) {
              const oldWinnings = winner.winnings_ton || 0;
              const oldTotalEarned = winner.totalEarned || 0;
              const newWinnings = oldWinnings + winAmount;
              const newTotalEarned = oldTotalEarned + winAmount;
              
              await updateUser(winnerId, {
                winnings_ton: newWinnings,
                totalEarned: newTotalEarned
              });
              
              prize = winAmount;
              const updatedUser = await getUser(winnerId);
              
              console.log(`💰 ВЫИГРЫШ ЗАЧИСЛЕН (JSON fallback): Игрок ${winnerId}, новый баланс: ${updatedUser.winnings_ton} TON`);
              
              io.to(`user_${winnerId}`).emit('balance_updated', {
                games_balance: updatedUser.games_balance,
                winnings_ton: updatedUser.winnings_ton
              });
            } else {
              console.log(`⚠️ Победитель ${winnerId} не найден в БД или является ботом. Выигрыш не начисляется.`);
              prize = 0;
            }
          } catch (error) {
            console.error(`❌ Ошибка получения пользователя ${winnerId} через getUser:`, error.message);
            prize = 0;
          }
        }
      } catch (error) {
        console.error(`❌ Ошибка при начислении приза:`, error);
        prize = 0;
      }
    }
  } else {
    // Ничья: лобовое столкновение или оба игрока проиграли одновременно
    console.log(`🏁 Игра ${gameId} завершена ничьей`);
    prize = 0;
  }
  
  // Сохраняем prize в объекте игры для использования при повторных вызовах
  game.prize = prize;
  
  // Помечаем, что выигрыш обработан (защита от повторного начисления)
  game.winnings_paid = true;
  
  // Уведомляем игроков (ОБЯЗАТЕЛЬНО отправляем событие, даже если игра уже завершена)
  if (!game.end_event_sent) {
    const roomName = `game_${gameId}`;
    console.log(`📤 Отправка game_end в комнату: ${roomName}`);
    
    // Если ничья (winnerId === null), отправляем специальное сообщение
    const eventData = {
      winnerId,
      prize: prize, // Всегда 0 при ничьей
      game_stats: {
        duration: game.end_time - game.start_time,
        pool: prize > 0 ? GAME_CONFIG.ENTRY_PRICE * 2 : 0
      },
      ...(!winnerId ? { message: 'Ничья! Оба игрока погибли. Приз остается в банке.' } : { message: `Вы выиграли ${prize.toFixed(2)} TON!` })
    };
    
    io.to(roomName).emit('game_end', eventData);
    game.end_event_sent = true; // Помечаем, что событие отправлено
    
    console.log(`✅ game_end отправлено игрокам в комнате ${roomName}:`, eventData);
    console.log(`   prize=${prize}, winnerId=${winnerId || 'null (ничья)'}`);
  } else {
    console.log(`⚠️ Событие game_end уже было отправлено ранее, пропускаем`);
  }
  
  // Очищаем из активных игр
  playerToGame.delete(game.player1_id);
  playerToGame.delete(game.player2_id);
  
  // Удаляем игру через 5 секунд (для истории), затем обрабатываем очередь
  setTimeout(() => {
    activeGames.delete(gameId);
    processQueue();
  }, 5000);
}

/**
 * Обработка очереди: при освобождении слота создаём игры из ожидающих пар.
 */
async function processQueue() {
  while (activeGames.size < GAME_CONFIG.MAX_CONCURRENT_GAMES) {
    const ids = Array.from(waitingPlayers.keys());
    if (ids.length < 2) break;
    const [p1, p2] = ids.slice(0, 2);
    const d1 = waitingPlayers.get(p1);
    const d2 = waitingPlayers.get(p2);
    if (!d1?.socketId || !d2?.socketId) {
      if (!d1?.socketId) waitingPlayers.delete(p1);
      if (!d2?.socketId) waitingPlayers.delete(p2);
      continue;
    }
    const s1 = io.sockets.sockets.get(d1.socketId);
    const s2 = io.sockets.sockets.get(d2.socketId);
    if (!s1 || !s2) {
      if (!s1) waitingPlayers.delete(p1);
      if (!s2) waitingPlayers.delete(p2);
      continue;
    }
    try {
      await createGame(p1, p2, d1.socketId, d2.socketId);
      console.log(`📋 Очередь: создана игра для ${p1} и ${p2}`);
    } catch (err) {
      console.error('❌ Очередь: ошибка createGame', err);
      break;
    }
  }
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
      winnings_ton: user.winnings_ton,
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
        winnings_ton: user.winnings_ton,
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

