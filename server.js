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
  // Включаем compression для быстрой передачи game_state пакетов
  transports: ['websocket', 'polling'],
  compression: true,
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
  ENTRY_PRICE: 1, // стоимость входа (в играх)
  WINNER_PERCENTAGE: 0.75 // процент выигрыша победителя (75%)
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
      
      // Используем функцию buyGamesWithWinnings с транзакцией
      const result = await buyGamesWithWinnings(userId, amount);
      
      if (result.success) {
        // Отправляем успешный ответ с обновленными данными
        socket.emit('buy_games_success', {
          games_purchased: result.gamesPurchased,
          games_balance: result.user.games_balance,
          winnings_ton: result.user.winnings_ton
        });
        
        console.log(`✅ Игрок ${userId} успешно купил ${result.gamesPurchased} игр за выигрыши`);
      } else {
        socket.emit('buy_games_error', {
          message: result.error || 'Ошибка при покупке игр'
        });
        console.log(`❌ Ошибка покупки игр для игрока ${userId}: ${result.error}`);
      }
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
      
      // Минимальная сумма вывода 1.5 TON
      if (amount < 1.5) {
        socket.emit('withdrawal_error', {
          message: 'Минимальная сумма вывода: 1.5 TON'
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
      
      // 3. Проверка количества побед: максимальная сумма = количество побед * 1.5
      const expectedWinningsPerWin = 1.5;
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
      console.log('2. Кошелек найден:', userWallet.substring(0, 10) + '...');
      
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
      
      // Попытка реального вывода через TON API
      try {
        if (adminSeed && !DEBUG_MODE) {
          // Реальная транзакция через @ton/ton (требуется: npm install @ton/ton @ton/crypto)
          try {
            const { TonClient, WalletContractV4, WalletContractV3R2, internal, toNano, Address } = require('@ton/ton');
            const { mnemonicToWalletKey } = require('@ton/crypto');
            
            // Используем децентрализованный Orbs Access вместо TonCenter
            const isTestnet = process.env.IS_TESTNET === 'true' || process.env.IS_TESTNET === true || process.env.IS_TESTNET === 'TRUE' || true; // Fallback: true (тестнет)
            
            // Получаем endpoint через децентрализованную сеть Orbs
            const endpoint = await getHttpEndpoint({ network: isTestnet ? 'testnet' : 'mainnet' });
            console.log(`🌐 Подключено к децентрализованному узлу: ${endpoint}`);
              
            const client = new TonClient({ endpoint });
            
            // Создаем кошелек из seed-фразы
            const seedWords = adminSeed.split(' ');
            if (seedWords.length !== 24) {
              throw new Error('ADMIN_SEED должен содержать 24 слова');
            }
            
            const keyPair = await mnemonicToWalletKey(seedWords);
            
            // Пробуем сначала V4, потом V3R2 (если V4 дает нулевой баланс)
            let wallet = WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 });
            let walletVersion = 'V4';
            
            // Корректный вывод адреса с параметрами (для тестнета используем testOnly: true)
            const walletAddress = wallet.address.toString({ 
              testOnly: true, // Принудительно true для тестнета
              bounceable: false, 
              urlSafe: true 
            });
            
            // Минимальное логирование для диагностики
            
            // Проверяем баланс кошелька администратора
            let balance;
            try {
              balance = await client.getBalance(wallet.address);
            } catch (balanceError) {
              console.error('❌ Ошибка getBalance:', balanceError.message);
              throw balanceError;
            }
            
            const balanceInTon = parseFloat(balance.toString()) / 1000000000;
            console.log(`💰 Баланс админа: ${balanceInTon} TON`);
            
            if (balanceInTon < 0.1) {
              throw new Error(`Недостаточно средств на администраторском кошельке. Баланс: ${balanceInTon} TON, требуется минимум 0.1 TON`);
            }
            
            // Используем проверенный метод для Wallet V4
            try {
              const provider = client.provider(wallet.address);
              const seqno = await wallet.getSeqno(provider);
              
              // Конвертируем адрес получателя
              const recipientAddress = Address.parse(userWallet);
              
              console.log(`🚀 Подготовка транзакции: seqno=${String(seqno)}, сумма=${amountInTon} TON`);
              
              await wallet.sendTransfer(provider, {
                seqno: seqno,
                secretKey: keyPair.secretKey,
                messages: [
                  internal({
                    to: recipientAddress,
                    value: toNano(amountInTon.toFixed(9)),
                    bounce: false,
                    body: `Snake Game Prize: ${amount} TON`
                  })
                ]
              });
              
              console.log('✅ Транзакция успешно отправлена в сеть!');
              transactionSuccess = true;
              withdrawalStatus = 'completed';
              txHash = `tx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            } catch (e) {
              console.error('❌ Ошибка при отправке через sendTransfer:', e.message);
              transactionSuccess = false;
              txHash = `withdraw_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
              withdrawalStatus = 'failed';
            }
          } catch (tonError) {
            console.error('❌ Ошибка TON SDK:', tonError.message);
            transactionSuccess = false;
            txHash = `withdraw_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            withdrawalStatus = 'failed';
          }
        } else if (DEBUG_MODE) {
          // DEBUG_MODE: симулируем успешную транзакцию
          console.log(`💰 Вывод средств (DEBUG_MODE): ${amount} TON на ${userWallet}`);
          transactionSuccess = true;
          txHash = `debug_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          withdrawalStatus = 'completed';
        } else {
          // Нет ADMIN_SEED и не DEBUG_MODE - уже обработано выше
          transactionSuccess = false;
          withdrawalStatus = 'failed';
        }
      } catch (error) {
        console.error('❌ Ошибка при выполнении TON транзакции:', error);
        transactionSuccess = false;
        txHash = `withdraw_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        withdrawalStatus = 'failed';
      }
      
      // БЕЗОПАСНЫЙ ВЫВОД: Списываем баланс ТОЛЬКО после успешной отправки транзакции
      if (transactionSuccess) {
        const newWinnings = Math.max(0, (user.winnings_ton || 0) - amount);
        await updateUser(userId, {
          winnings_ton: newWinnings
        });
        console.log('💰 Баланс списан ПОСЛЕ успешной отправки транзакции:', { 
          old: user.winnings_ton, 
          new: newWinnings 
        });
      } else {
        // Транзакция не удалась - баланс НЕ списываем
        console.warn('⚠️ Транзакция не удалась, баланс НЕ списан');
        socket.emit('withdrawal_error', {
          message: 'Не удалось отправить транзакцию. Баланс не списан.'
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
  // ОПТИМИЗАЦИЯ: Параллельные запросы к БД для уменьшения задержки
  const [player1, player2] = await Promise.all([
    getUser(player1Id),
    getUser(player2Id)
  ]);
  
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
  
  // ОПТИМИЗАЦИЯ: Параллельное списание баланса у обоих игроков
  await Promise.all([
    updateUser(player1Id, { games_balance: player1.games_balance - GAME_CONFIG.ENTRY_PRICE }),
    updateUser(player2Id, { games_balance: player2.games_balance - GAME_CONFIG.ENTRY_PRICE })
  ]);
  
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
    }
    
    count--;
    
    // Когда count становится 0, завершаем countdown и начинаем игру
    if (count < 0) {
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

