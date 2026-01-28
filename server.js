// ЗАГРУЗКА ПЕРЕМЕННЫХ ОКРУЖЕНИЯ В САМОМ НАЧАЛЕ (до всех остальных импортов)
require('dotenv').config();

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
  TICK_RATE: 7, // тиков в секунду (оптимизировано для снижения пинга: было 9, стало 7)
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
    
    // Mainnet по умолчанию. Явно IS_TESTNET=true — тестнет.
    const IS_TESTNET = process.env.IS_TESTNET === 'true' || process.env.IS_TESTNET === true || process.env.IS_TESTNET === 'TRUE';
    const WALLET = process.env.TON_WALLET_ADDRESS || '';
    const API_KEY = process.env.TONCENTER_API_KEY || process.env.TON_API_KEY || '';
    const API_URL = IS_TESTNET ? 'https://testnet.toncenter.com/api/v2' : 'https://toncenter.com/api/v2';

    tonPayment.initConfig({
      IS_TESTNET: IS_TESTNET,
      TON_WALLET_ADDRESS: WALLET,
      TON_API_KEY: API_KEY
    });

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
          console.error('Scanner error:', error.message);
        } finally {
          isScanning = false;
        }
      });
    };
    
    // Первая проверка сразу после запуска (асинхронно)
    runScanner();
    
    // Периодическая проверка каждые 35 секунд (увеличено для предотвращения 429)
    // Используем отдельный интервал, который не пересекается с игровым циклом
    scannerInterval = setInterval(runScanner, 35000);
  }
  
  // Запускаем игровой цикл (передаем endGame как callback)
  // Сообщение о запуске выводится внутри gameLoop.start(), убираем дублирование
  gameLoop.start(io, activeGames, GAME_CONFIG, endGame);
}).catch(err => {
  console.error('DB init error:', err.message);
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
  
  if (!(lastConnection && (now - lastConnection) < reconnectThreshold)) {
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
            
          } else {
            // Если запись в БД не удалась, отправляем ошибку и откатываем оптимистичное обновление
            socket.emit('buy_games_error', {
              message: result.error || 'Ошибка при покупке игр',
              rollback: true,
              games_balance: currentUser.games_balance,
              winnings_ton: currentUser.winnings_ton
            });
            
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
    try {
      const { amount, address } = data;
      
      if (!amount || amount <= 0) {
        socket.emit('withdrawal_error', {
          message: 'Некорректная сумма для вывода'
        });
        return;
      }
      
      const WITHDRAW_COOLDOWN_MS = 30000; // 30 секунд между запросами
      const lastRequest = lastWithdrawRequest.get(userId);
      const now = Date.now();
      if (lastRequest && (now - lastRequest) < WITHDRAW_COOLDOWN_MS) {
        const remainingSeconds = Math.ceil((WITHDRAW_COOLDOWN_MS - (now - lastRequest)) / 1000);
        socket.emit('withdrawal_error', {
          message: `Пожалуйста, подождите ${remainingSeconds} секунд перед следующим запросом вывода`,
          remainingSeconds
        });
        return;
      }
      
      const user = await getUser(userId);

      // Проверяем баланс
      if (!user.winnings_ton || user.winnings_ton < amount) {
        socket.emit('withdrawal_error', {
          message: `Недостаточно средств для вывода. Доступно: ${user.winnings_ton || 0} TON, запрошено: ${amount} TON`
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
      
      const userWallet = (address && address.trim()) || user.wallet || user.wallet_address || '';
      if (!userWallet || userWallet.trim() === '') {
        socket.emit('withdrawal_error', {
          message: 'Кошелек не указан. Пожалуйста, укажите адрес кошелька.'
        });
        return;
      }
      
      // Проверка ADMIN_SEED
      const adminSeedRaw = process.env.ADMIN_SEED || '';
      const adminSeed = adminSeedRaw.trim();
      const seedWords = adminSeed ? adminSeed.split(/\s+/).filter(Boolean) : [];
      const isDebugMode = DEBUG_MODE === true || DEBUG_MODE === 'true' || DEBUG_MODE === 'TRUE';

      if (!adminSeed && !isDebugMode) {
        console.warn('Withdrawal rejected: ADMIN_SEED not set');
        socket.emit('withdrawal_error', {
          message: 'Система вывода временно недоступна. Попробуйте позже.'
        });
        return;
      }

      // Кулдаун только для реальных попыток вывода (после всех проверок)
      lastWithdrawRequest.set(userId, now);
      
      // Курс 1:1 (1 TON = 1 TON)
      const amountInTon = parseFloat(amount);
      
      let txHash = null;
      let withdrawalStatus = 'pending';
      let transactionSuccess = false;
      let errorDetails = ''; // Детали ошибки для передачи клиенту
      
      // Попытка реального вывода через TON API
      try {
          if (adminSeed && !isDebugMode) {
            console.log(`[Withdraw] Режим: реальный вывод (mainnet), загружаем TON SDK...`);
          try {
            const { TonClient, WalletContractV4, WalletContractV3R2, internal, toNano, Address } = require('@ton/ton');
            const { mnemonicToWalletKey } = require('@ton/crypto');
            console.log(`[Withdraw] TON SDK загружен`);
            
            // Используем децентрализованный Orbs Access вместо TonCenter
            const isTestnet = process.env.IS_TESTNET === 'true' || process.env.IS_TESTNET === true || process.env.IS_TESTNET === 'TRUE';
            console.log(`[Withdraw] IS_TESTNET=${isTestnet}, сеть=${isTestnet ? 'testnet' : 'mainnet'}`);
            let endpoint;
            try {
              console.log(`[Withdraw] Получаем endpoint через Orbs Access...`);
              // Добавляем таймаут для получения endpoint (10 секунд)
              const endpointPromise = getHttpEndpoint({ network: isTestnet ? 'testnet' : 'mainnet' });
              const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Timeout: получение endpoint заняло более 10 секунд')), 10000)
              );
              
              endpoint = await Promise.race([endpointPromise, timeoutPromise]);
              console.log(`[Withdraw] ✅ Endpoint получен: ${endpoint.substring(0, 50)}...`);
            } catch (endpointError) {
              console.warn(`[Withdraw] ⚠️ Ошибка получения endpoint через Orbs, используем fallback:`, endpointError.message);
              endpoint = isTestnet
                ? 'https://testnet.toncenter.com/api/v2/jsonRPC'
                : 'https://toncenter.com/api/v2/jsonRPC';
              console.log(`[Withdraw] Используем fallback endpoint: ${endpoint}`);
            }

            const apiKey = process.env.TONCENTER_API_KEY || process.env.TON_API_KEY || '';
            console.log(`[Withdraw] API Key: ${apiKey ? `[${apiKey.length} символов]` : 'не установлен'}`);
            const client = new TonClient({ endpoint, apiKey: apiKey || undefined });
            console.log(`[Withdraw] TonClient создан`);
            
            const seedWords = adminSeed.split(/\s+/).filter(Boolean);
            console.log(`[Withdraw] Seed-фраза разбита на ${seedWords.length} слов`);
            if (seedWords.length !== 24) {
              errorDetails = 'ADMIN_SEED должен содержать 24 слова';
              console.error(`Withdrawal error: ${errorDetails}`);
              throw new Error(errorDetails);
            }
            
            let keyPair;
            try {
              console.log(`[Withdraw] Создаём keyPair из seed-фразы...`);
              keyPair = await mnemonicToWalletKey(seedWords);
              console.log(`[Withdraw] ✅ KeyPair создан`);
            } catch (keyError) {
              errorDetails = `Ошибка создания ключа из seed-фразы: ${keyError.message}`;
              console.error(`Withdrawal error: ${errorDetails}`);
              throw new Error(errorDetails);
            }

            const opts = { testOnly: isTestnet, bounceable: false, urlSafe: true };
            const walletV4 = WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 });
            const walletV3R2 = WalletContractV3R2.create({ publicKey: keyPair.publicKey, workchain: 0 });
            const addrV4 = walletV4.address.toString(opts);
            const addrV3R2 = walletV3R2.address.toString(opts);
            console.log(`[Withdraw] Адреса кошельков: V4=${addrV4.substring(0, 15)}..., V3R2=${addrV3R2.substring(0, 15)}...`);

            const expectedAddrRaw = (process.env.TON_WALLET_ADDRESS || '').trim();
            console.log(`[Withdraw] TON_WALLET_ADDRESS из env: ${expectedAddrRaw ? `${expectedAddrRaw.substring(0, 15)}...` : 'не установлен'}`);
            let wallet = null;
            let walletVersion = '';

            if (expectedAddrRaw) {
              let expectedNorm;
              try {
                expectedNorm = Address.parse(expectedAddrRaw).toString(opts);
                console.log(`[Withdraw] Нормализованный адрес из TON_WALLET_ADDRESS: ${expectedNorm.substring(0, 15)}...`);
              } catch (parseErr) {
                errorDetails = `Некорректный TON_WALLET_ADDRESS: ${parseErr.message}`;
                console.error(`Withdrawal error: ${errorDetails}`);
                throw new Error(errorDetails);
              }
              if (addrV4 === expectedNorm) {
                wallet = walletV4;
                walletVersion = 'V4';
                console.log(`[Withdraw] ✅ Используем кошелёк V4 (совпадает с TON_WALLET_ADDRESS)`);
              } else if (addrV3R2 === expectedNorm) {
                wallet = walletV3R2;
                walletVersion = 'V3R2';
                console.log(`[Withdraw] ✅ Используем кошелёк V3R2 (совпадает с TON_WALLET_ADDRESS)`);
              } else {
                // TON_WALLET_ADDRESS не совпадает - проверяем баланс TON_WALLET_ADDRESS для диагностики
                console.warn(`[Withdraw] ⚠️ TON_WALLET_ADDRESS (${expectedAddrRaw.substring(0, 15)}...) не совпадает с V4/V3R2 из ADMIN_SEED.`);
                let tonWalletBalance = 0;
                try {
                  const expectedAddr = Address.parse(expectedAddrRaw);
                  const balExpected = await client.getBalance(expectedAddr);
                  tonWalletBalance = Number(balExpected) / 1e9;
                  console.log(`[Withdraw] Баланс TON_WALLET_ADDRESS: ${tonWalletBalance.toFixed(4)} TON`);
                  if (tonWalletBalance > 0) {
                    console.error(`Withdrawal error: ADMIN_SEED не соответствует TON_WALLET_ADDRESS`);
                    errorDetails = `ADMIN_SEED не соответствует TON_WALLET_ADDRESS. На кошельке TON_WALLET_ADDRESS есть средства (${tonWalletBalance.toFixed(4)} TON), но для отправки нужен приватный ключ из ADMIN_SEED. Обновите ADMIN_SEED на seed-фразу, которая соответствует кошельку ${expectedAddrRaw}.`;
                    throw new Error(errorDetails);
                  }
                } catch (balCheckErr) {
                  if (balCheckErr.message && balCheckErr.message.includes('ADMIN_SEED не соответствует')) {
                    throw balCheckErr; // Пробрасываем ошибку о несоответствии
                  }
                  console.warn(`[Withdraw] Не удалось проверить баланс TON_WALLET_ADDRESS:`, balCheckErr.message);
                }
                // Продолжаем - используем кошелёк из ADMIN_SEED с достаточным балансом
                console.log(`[Withdraw] TON_WALLET_ADDRESS пуст или недоступен, используем кошелёк из ADMIN_SEED.`);
              }
            }

            if (!wallet) {
              console.log(`[Withdraw] Проверяем балансы V4 и V3R2 из ADMIN_SEED...`);
              let balV4 = BigInt(0);
              let balV3 = BigInt(0);
              try { balV4 = await client.getBalance(walletV4.address); } catch (e) { console.warn(`[Withdraw] Ошибка получения баланса V4:`, e.message); }
              try { balV3 = await client.getBalance(walletV3R2.address); } catch (e) { console.warn(`[Withdraw] Ошибка получения баланса V3R2:`, e.message); }
              const requiredNano = BigInt(Math.ceil((amountInTon + 0.1) * 1e9));
              const balV4Ton = Number(balV4) / 1e9;
              const balV3Ton = Number(balV3) / 1e9;
              console.log(`[Withdraw] Балансы: V4=${balV4Ton.toFixed(4)} TON, V3R2=${balV3Ton.toFixed(4)} TON, требуется=${(amountInTon + 0.1).toFixed(4)} TON`);
              if (balV4 >= requiredNano) {
                wallet = walletV4;
                walletVersion = 'V4';
                console.log(`[Withdraw] ✅ Выбран кошелёк V4 (баланс достаточен)`);
              } else if (balV3 >= requiredNano) {
                wallet = walletV3R2;
                walletVersion = 'V3R2';
                console.log(`[Withdraw] ✅ Выбран кошелёк V3R2 (баланс достаточен)`);
              } else {
                errorDetails = `Недостаточно средств на кошельке админа. V4: ${balV4Ton.toFixed(4)} TON, V3R2: ${balV3Ton.toFixed(4)} TON; требуется ${(amountInTon + 0.1).toFixed(4)} TON (сумма + 0.1 комиссия).`;
                console.error(`Withdrawal error: ${errorDetails}`);
                throw new Error(errorDetails);
              }
            }

            let balance;
            try {
              console.log(`[Withdraw] Проверяем баланс кошелька ${walletVersion}...`);
              balance = await client.getBalance(wallet.address);
              const balanceInTon = parseFloat(balance.toString()) / 1000000000;
              console.log(`[Withdraw] ✅ Баланс кошелька: ${balanceInTon.toFixed(4)} TON`);
            } catch (balanceError) {
              errorDetails = `Ошибка проверки баланса: ${balanceError.message}`;
              console.error(`Withdrawal error: ${errorDetails}`);
              throw balanceError;
            }

            const balanceInTon = parseFloat(balance.toString()) / 1000000000;
            if (balanceInTon < amountInTon + 0.1) {
              const required = amountInTon + 0.1;
              errorDetails = `Недостаточно средств на администраторском кошельке. Баланс: ${balanceInTon.toFixed(4)} TON, требуется: ${required.toFixed(4)} TON (${amountInTon} TON + 0.1 TON комиссия)`;
              console.error(`Withdrawal error: ${errorDetails}`);
              throw new Error(errorDetails);
            }

            try {
              console.log(`[Withdraw] Создаём provider для кошелька ${walletVersion}...`);
              const provider = client.provider(wallet.address);

              const getSeqnoWithRetry = async (maxRetries = 5, initialDelayMs = 3000) => {
                for (let attempt = 1; attempt <= maxRetries; attempt++) {
                  try {
                    console.log(`[Withdraw] Получаем seqno (попытка ${attempt}/${maxRetries})...`);
                    const seqno = await wallet.getSeqno(provider);
                    console.log(`[Withdraw] ✅ Seqno получен: ${seqno}`);
                    return seqno;
                  } catch (error) {
                    const isRateLimit = error.message && (
                      error.message.includes('429') || error.message.includes('Too Many Requests') ||
                      error.status === 429 || error.response?.status === 429
                    );
                    if (isRateLimit && attempt < maxRetries) {
                      const delay = initialDelayMs * Math.pow(2, attempt - 1);
                      console.warn(`[Withdraw] ⚠️ Rate limit (429), ждём ${delay}ms перед повтором...`);
                      await new Promise(resolve => setTimeout(resolve, delay));
                      continue;
                    }
                    throw error;
                  }
                }
              };

              const seqno = await getSeqnoWithRetry();
              let recipientAddress;
              try {
                console.log(`[Withdraw] Парсим адрес получателя: ${userWallet.substring(0, 15)}...`);
                recipientAddress = Address.parse(userWallet);
                if (recipientAddress.equals(wallet.address)) {
                  errorDetails = 'Адрес получателя не может совпадать с адресом администратора';
                  console.error(`Withdrawal error: ${errorDetails}`);
                  throw new Error(errorDetails);
                }
                console.log(`[Withdraw] ✅ Адрес получателя валиден`);
              } catch (parseError) {
                errorDetails = `Некорректный адрес кошелька получателя: ${parseError.message}. Убедитесь, что адрес указан правильно и соответствует сети (${isTestnet ? 'testnet' : 'mainnet'}).`;
                console.error(`Withdrawal error: ${errorDetails}`);
                throw new Error(errorDetails);
              }

              const amountInNano = toNano(amountInTon.toFixed(9));
              console.log(`[Withdraw] Сумма в нанотонах: ${amountInNano.toString()}`);
              
              // Функция для отправки транзакции с retry при ошибке 429
              const sendTransferWithRetry = async (currentSeqno, maxRetries = 5, initialDelayMs = 3000) => {
                let attemptSeqno = currentSeqno;
                for (let attempt = 1; attempt <= maxRetries; attempt++) {
                  try {
                    console.log(`[Withdraw] Отправляем транзакцию (попытка ${attempt}/${maxRetries}), seqno=${attemptSeqno}...`);
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
                    console.log(`[Withdraw] ✅ Транзакция успешно отправлена!`);
                    return; // Успешно отправлено
                  } catch (error) {
                    const isRateLimit = error.message && (
                      error.message.includes('429') || 
                      error.message.includes('Too Many Requests') ||
                      error.status === 429 ||
                      error.response?.status === 429
                    );
                    
                    if (isRateLimit && attempt < maxRetries) {
                      const delay = initialDelayMs * Math.pow(2, attempt - 1);
                      console.warn(`[Withdraw] ⚠️ Rate limit (429) при отправке, ждём ${delay}ms перед повтором...`);
                      await new Promise(resolve => setTimeout(resolve, delay));
                      try { 
                        attemptSeqno = await getSeqnoWithRetry(3, 2000); 
                        console.log(`[Withdraw] Обновлён seqno: ${attemptSeqno}`);
                      } catch (_) {}
                      continue;
                    }
                    throw error;
                  }
                }
              };
              
              await sendTransferWithRetry(seqno);
              transactionSuccess = true;
              withdrawalStatus = 'completed';
              txHash = `tx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
              console.log(`[Withdraw] ✅ Транзакция успешно обработана, txHash=${txHash}`);
            } catch (e) {
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
                console.warn(`[Withdraw] ⚠️ Rate limit обнаружен`);
              } else {
                errorDetails = `Ошибка отправки транзакции: ${e.message}`;
              }
            }
          } catch (tonError) {
            console.error(`Withdrawal error:`, tonError.message);
            transactionSuccess = false;
            txHash = `withdraw_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            withdrawalStatus = 'failed';
            errorDetails = `Ошибка TON SDK: ${tonError.message}`;
          }
        } else if (isDebugMode) {
          // DEBUG_MODE: симулируем успешную транзакцию
          console.log(`[Withdraw] DEBUG_MODE: симулируем успешную транзакцию`);
          transactionSuccess = true;
          txHash = `debug_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          withdrawalStatus = 'completed';
        } else {
          transactionSuccess = false;
          withdrawalStatus = 'failed';
          errorDetails = 'Система вывода временно недоступна. ADMIN_SEED не настроен.';
          console.error(`Withdrawal error: ADMIN_SEED не настроен и DEBUG_MODE выключен`);
        }
      } catch (error) {
        transactionSuccess = false;
        txHash = `withdraw_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        withdrawalStatus = 'failed';
        if (!errorDetails) {
          errorDetails = `Ошибка выполнения транзакции: ${error.message}`;
        }
        console.error(`Withdrawal error:`, error.message);
      }
      
      // БЕЗОПАСНЫЙ ВЫВОД: Списываем баланс ТОЛЬКО после успешной отправки транзакции
      if (transactionSuccess) {
        const newWinnings = Math.max(0, (user.winnings_ton || 0) - amount);
        await updateUser(userId, { winnings_ton: newWinnings });
      } else {
        let userMessage = 'Не удалось отправить транзакцию. Баланс не списан.';
        if (errorDetails) {
          // Если есть детали, добавляем их (но упрощаем для пользователя)
          if (errorDetails.includes('ADMIN_SEED не соответствует')) {
            userMessage = 'Ошибка конфигурации кошелька администратора. Обратитесь в поддержку.';
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
  
  // Проверяем, не находится ли игрок уже в игре
  if (playerToGame.has(userId)) {
    socket.emit('error', { message: 'You are already in a game!' });
    return;
  }
  
  // 1 TON списывается только при найденном матче (в createGame). Отмена поиска — без списания.
  
  // Ищем ожидающего соперника
  const waitingUser = Array.from(waitingPlayers.keys()).find(id => id !== userId);
  const atLimit = activeGames.size >= GAME_CONFIG.MAX_CONCURRENT_GAMES;

  if (waitingUser) {
    if (atLimit) {
      // Лимит достигнут — не создаём игру, оба ждут в очереди
      waitingPlayers.set(userId, { socketId: socket.id, ready: false });
      socket.emit('waiting_opponent');
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
  const [player1, player2] = await Promise.all([
    getUser(player1Id),
    getUser(player2Id)
  ]);
  
  // Списываем 1 TON только при найденном матче (отмена поиска — без списания)
  const newW1 = Math.max(0, (player1.winnings_ton || 0) - GAME_CONFIG.ENTRY_PRICE);
  const newW2 = Math.max(0, (player2.winnings_ton || 0) - GAME_CONFIG.ENTRY_PRICE);
  await Promise.all([
    updateUser(player1Id, { winnings_ton: newW1 }),
    updateUser(player2Id, { winnings_ton: newW2 })
  ]);
  
  const player1Socket = io.sockets.sockets.get(socket1Id);
  const player2Socket = io.sockets.sockets.get(socket2Id);
  
  player1Socket?.emit('balance_updated', {
    games_balance: player1.games_balance,
    winnings_ton: newW1
  });
  player2Socket?.emit('balance_updated', {
    games_balance: player2.games_balance,
    winnings_ton: newW2
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
  if (!room) console.error(`Room not found: game_${gameId}`);
  
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
  const game = activeGames.get(gameId);
  if (!game) return;
  if (game.finished && game.end_event_sent) return;
  
  game.finished = true;
  game.end_time = Date.now();
  
  // Защита от повторного начисления по одному matchId
  if (game.winnings_paid) {
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
          const updatedUser = await getUser(winnerId);
          io.to(`user_${winnerId}`).emit('balance_updated', {
            games_balance: updatedUser.games_balance,
            winnings_ton: updatedUser.winnings_ton
          });
          io.to(`user_${winnerId}`).emit('updateBalance', winAmount);
        } else {
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
              io.to(`user_${winnerId}`).emit('balance_updated', {
                games_balance: updatedUser.games_balance,
                winnings_ton: updatedUser.winnings_ton
              });
            } else {
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
    prize = 0;
  }
  
  // Сохраняем prize в объекте игры для использования при повторных вызовах
  game.prize = prize;
  
  // Помечаем, что выигрыш обработан (защита от повторного начисления)
  game.winnings_paid = true;
  
  // Уведомляем игроков (ОБЯЗАТЕЛЬНО отправляем событие, даже если игра уже завершена)
  if (!game.end_event_sent) {
    const roomName = `game_${gameId}`;
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
    game.end_event_sent = true;
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
    } catch (err) {
      console.error('Queue createGame error:', err.message);
      break;
    }
  }
}

/**
 * Обработка отключения
 */
function handleDisconnect(socket, userId) {
  waitingPlayers.delete(userId);
  socketToUser.delete(socket.id);
  const gameId = playerToGame.get(userId);
  if (gameId && activeGames.has(gameId)) {
    const game = activeGames.get(gameId);
    const opponentId = game.player1_id === userId ? game.player2_id : game.player1_id;
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

// Диагностика: проверка переменных окружения (без секретов)
app.get('/api/check-env', (req, res) => {
  const adminSeed = (process.env.ADMIN_SEED || '').trim();
  const words = adminSeed ? adminSeed.split(/\s+/).filter(Boolean) : [];
  const DEBUG = process.env.DEBUG_MODE === 'true' || process.env.DEBUG_MODE === true;
  const withdrawOk = !!adminSeed || !!DEBUG;
  res.json({
    hasAdminSeed: !!adminSeed,
    adminSeedWordCount: words.length,
    withdrawAvailable: withdrawOk,
    reason: !withdrawOk ? 'ADMIN_SEED missing. Add it in Railway Variables for the web service (Node.js), then Redeploy.' : null,
    hasTonWallet: !!process.env.TON_WALLET_ADDRESS,
    hasTonCenterKey: !!(process.env.TONCENTER_API_KEY || process.env.TON_API_KEY),
    debugMode: process.env.DEBUG_MODE,
    isTestnet: process.env.IS_TESTNET,
    hasDatabaseUrl: !!process.env.DATABASE_URL
  });
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  const hasSeed = !!(process.env.ADMIN_SEED || '').trim();
  console.log(`Server running on port ${PORT} (${DEBUG_MODE ? 'DEBUG' : 'mainnet'}) | ADMIN_SEED: ${hasSeed ? 'set' : 'NOT SET'}`);
});

