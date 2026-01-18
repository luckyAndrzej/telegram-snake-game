/**
 * Модуль для работы с TON Testnet платежами
 * Использует TonCenter API для проверки транзакций
 */

const fs = require('fs').promises;
const path = require('path');
const { getUser, updateUser } = require('../db/users');

// Конфигурация из .env (будет загружена через initConfig в server.js)
// Значения по умолчанию (будут переопределены через initConfig)
let TON_CONFIG = {
  IS_TESTNET: false,
  TON_API_URL: 'https://toncenter.com/api/v2',
  TON_WALLET_ADDRESS: '',
  TON_API_KEY: ''
};

// Пути к файлам для хранения платежей и транзакций
const PENDING_PAYMENTS_FILE = path.join(__dirname, '..', 'pending_payments.json');
const PROCESSED_TX_FILE = path.join(__dirname, '..', 'processed_tx.json');

/**
 * Инициализация файлов для хранения платежей и транзакций
 */
async function initPaymentFiles() {
  try {
    // Создаем pending_payments.json если его нет
    try {
      await fs.access(PENDING_PAYMENTS_FILE);
    } catch {
      await fs.writeFile(PENDING_PAYMENTS_FILE, JSON.stringify({}, null, 2));
      console.log('✅ Создан файл pending_payments.json');
    }

    // Создаем processed_tx.json если его нет
    try {
      await fs.access(PROCESSED_TX_FILE);
    } catch {
      await fs.writeFile(PROCESSED_TX_FILE, JSON.stringify({}, null, 2));
      console.log('✅ Создан файл processed_tx.json');
    }
  } catch (error) {
    console.error('❌ Ошибка инициализации файлов платежей:', error);
  }
}

/**
 * Генерация уникального комментария для платежа (8 символов)
 */
function generateComment() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789'; // Без O и I для читаемости
  let comment = '';
  for (let i = 0; i < 8; i++) {
    comment += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return comment;
}

/**
 * Пакеты игр (1$ = 1 игра = 1 TON, 5$ = 5 игр = 5 TON, 10$ = 10 игр = 10 TON)
 * Цены отображаются в долларах, платежи принимаются в TON
 */
const PACKAGES = {
  pkg_1: { amount: 1, games: 1, priceUsd: 1 },    // $1 = 1 игра = 1 TON
  pkg_5: { amount: 5, games: 5, priceUsd: 5 },    // $5 = 5 игр = 5 TON
  pkg_10: { amount: 10, games: 10, priceUsd: 10 }  // $10 = 10 игр = 10 TON
};

/**
 * Конвертация TON в нанотоны (1 TON = 1,000,000,000 нанотонов)
 */
function tonToNanoTon(ton) {
  return Math.floor(ton * 1000000000).toString();
}

/**
 * Конвертация нанотонов в TON
 */
function nanoTonToTon(nanoTon) {
  return parseFloat(nanoTon) / 1000000000;
}

/**
 * Создание платежного запроса
 * @param {number} userId - ID пользователя
 * @param {string} packageId - ID пакета (pkg_1, pkg_5, pkg_10)
 * @returns {Promise<Object>} - Данные платежа (comment, amount в нанотонах, games)
 */
async function createPayment(userId, packageId) {
  try {
    // Проверяем, что пакет существует
    const pkg = PACKAGES[packageId];
    if (!pkg) {
      return {
        success: false,
        error: 'Invalid package ID'
      };
    }

    // Генерируем уникальный комментарий
    const comment = generateComment();

    // Читаем текущие pending_payments
    let pendingPayments = {};
    try {
      const data = await fs.readFile(PENDING_PAYMENTS_FILE, 'utf8');
      pendingPayments = JSON.parse(data);
    } catch {
      pendingPayments = {};
    }

    // Создаем запись о платеже
    const paymentId = `payment_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    pendingPayments[paymentId] = {
      userId,
      packageId,
      comment,
      amount: pkg.amount, // TON
      games: pkg.games,
      createdAt: Date.now(),
      status: 'pending'
    };

    // Сохраняем в файл
    await fs.writeFile(PENDING_PAYMENTS_FILE, JSON.stringify(pendingPayments, null, 2));

    console.log(`💰 Создан платеж: userId=${userId}, package=${packageId}, comment=${comment}, amount=${pkg.amount} TON`);

    return {
      success: true,
      paymentId,
      comment,
      amount: tonToNanoTon(pkg.amount), // Возвращаем в нанотонах для Deep Link
      amountTon: pkg.amount, // Возвращаем в TON для отображения
      games: pkg.games,
      walletAddress: TON_CONFIG.TON_WALLET_ADDRESS
    };
  } catch (error) {
    console.error('❌ Ошибка создания платежа:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Получение транзакций кошелька через TonCenter API
 */
async function getWalletTransactions(address) {
  try {
    // Ограничиваем количество транзакций до 5 для снижения нагрузки
    const url = `${TON_CONFIG.TON_API_URL}/getTransactions?address=${address}&limit=5`;
    const headers = TON_CONFIG.TON_API_KEY 
      ? { 'X-API-Key': TON_CONFIG.TON_API_KEY }
      : {};

    // Логирование полного URL для отладки
    console.log(`🌐 Запрос к TonCenter API:`);
    console.log(`   Full URL: ${url}`);
    console.log(`   API URL (base): ${TON_CONFIG.TON_API_URL}`);
    console.log(`   IS_TESTNET: ${TON_CONFIG.IS_TESTNET}`);
    console.log(`   Has API Key: ${!!TON_CONFIG.TON_API_KEY}`);

    const response = await fetch(url, { headers });
    
    // Обработка ошибки 429 (Too Many Requests) с задержкой
    if (response.status === 429) {
      // Не логируем 429, чтобы не забивать логи - просто возвращаем пустой массив
      return [];
    }
    
    if (!response.ok) {
      throw new Error(`TonCenter API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    console.log(`📊 TonCenter API response: ok=${data.ok}, transactions count=${data.result?.length || 0}`);
    return data.ok ? data.result : [];
  } catch (error) {
    // Если ошибка 429, не логируем, чтобы не забивать логи
    if (error.response?.status === 429) {
      return [];
    }
    console.error('❌ Ошибка получения транзакций:', error);
    return [];
  }
}

/**
 * Проверка платежей TON (алиас для scanTransactions для совместимости с промптом)
 */
async function checkTonPayments(io) {
  return scanTransactions(io);
}

/**
 * Сканирование транзакций и обработка платежей
 * Проверяет транзакции кошелька и обрабатывает платежи с комментариями
 */
async function scanTransactions(io) {
  try {
    if (!TON_CONFIG.TON_WALLET_ADDRESS) {
      console.warn('⚠️ TON_WALLET_ADDRESS не настроен, пропускаем сканирование');
      return;
    }

    const walletAddress = TON_CONFIG.TON_WALLET_ADDRESS;
    // Убраны лишние логи для производительности - только критичные

    // Получаем транзакции кошелька
    const transactions = await getWalletTransactions(walletAddress);
    
    // Логируем только если есть транзакции
    if (transactions.length > 0) {
      console.log(`📊 Проверка ${transactions.length} транзакций для кошелька: ${walletAddress.substring(0, 10)}...`);
    }

    // Читаем processed_tx.json (обработанные транзакции)
    let processedTx = {};
    try {
      const data = await fs.readFile(PROCESSED_TX_FILE, 'utf8');
      processedTx = JSON.parse(data);
    } catch {
      processedTx = {};
    }

    // Читаем pending_payments.json (ожидающие платежи)
    let pendingPayments = {};
    try {
      const data = await fs.readFile(PENDING_PAYMENTS_FILE, 'utf8');
      pendingPayments = JSON.parse(data);
    } catch {
      pendingPayments = {};
    }

    // Обрабатываем каждую транзакцию
    for (const tx of transactions) {
      const txHash = tx.transaction_id?.hash || tx.hash || tx.txHash;
      
      if (!txHash) {
        continue; // Убраны лишние логи для производительности
      }

      // Пропускаем, если транзакция уже обработана
      if (processedTx[txHash]) {
        continue;
      }

      // Проверяем входящее сообщение (комментарий)
      const inMsg = tx.in_msg;
      if (!inMsg) {
        continue; // Убраны лишние логи для производительности
      }
      
      // Логируем только потенциально релевантные транзакции (с комментариями)
      const txComment = tx.in_msg?.message || tx.in_msg?.msg_data?.text || '';

      // Извлекаем комментарий из транзакции
      // Упрощенная логика без сложных замен
      let extractedComment = '';
      
      // Функция проверки валидного Base64
      function isBase64(str) {
        if (!str || typeof str !== 'string') return false;
        // Base64 должна содержать только: A-Z, a-z, 0-9, +, /, =
        const base64Pattern = /^[A-Za-z0-9+/]+=*$/;
        return base64Pattern.test(str) && str.length >= 4;
      }
      
      // ПРИОРИТЕТ 1: Если msg_data.text существует, сначала пробуем декодировать из Base64
      if (inMsg.msg_data && inMsg.msg_data.text && typeof inMsg.msg_data.text === 'string') {
        const trimmed = inMsg.msg_data.text.trim();
        try {
          // Пробуем декодировать из Base64
          if (isBase64(trimmed)) {
            const decoded = Buffer.from(trimmed, 'base64').toString('utf-8');
            // Используем декодированный результат
            extractedComment = decoded;
          } else if (!trimmed.startsWith('0x')) {
            // Если не Base64 и не Hex, используем как обычный текст
            extractedComment = trimmed;
          }
        } catch (decodeError) {
          // Если декодирование не удалось, пробуем как обычный текст
          if (!trimmed.startsWith('0x')) {
            extractedComment = trimmed;
          }
        }
      }
      
      // ПРИОРИТЕТ 2: Если не нашли в msg_data.text, проверяем in_msg.message
      if (!extractedComment && inMsg.message && typeof inMsg.message === 'string') {
        const trimmed = inMsg.message.trim();
        try {
          if (isBase64(trimmed)) {
            const decoded = Buffer.from(trimmed, 'base64').toString('utf-8');
            extractedComment = decoded;
          } else if (!trimmed.startsWith('0x')) {
            extractedComment = trimmed;
          }
        } catch (decodeError) {
          if (!trimmed.startsWith('0x')) {
            extractedComment = trimmed;
          }
        }
      }
      
      // Нормализация: ТОЛЬКО trim() и toUpperCase(), без других замен
      const comment = extractedComment ? extractedComment.trim().toUpperCase() : '';

      // Если комментарий пустой, пропускаем транзакцию
      if (!comment || comment.length === 0) {
        continue;
      }
      
      // Ищем платеж с таким комментарием в pending_payments
      let foundPaymentId = null;
      let foundPayment = null;
      const pendingComments = Object.values(pendingPayments).map(p => (p.comment || '').toUpperCase().trim());

      // Единственный лог сравнения
      console.log(`[Сканер] Сверяю: полученный [${comment}] и ожидаемый [${pendingComments.join(', ')}]`);

      // Точное совпадение: сравниваем комментарий с базой
      for (const [paymentId, payment] of Object.entries(pendingPayments)) {
        const paymentComment = (payment.comment || '').toUpperCase().trim();
        if (paymentComment === comment && payment.status === 'pending') {
          foundPaymentId = paymentId;
          foundPayment = payment;
          break;
        }
      }

      if (!foundPayment) {
        continue;
      }

      // Жирное логирование найденного совпадения
      console.log('\n========================================');
      console.log(`✅ НАЙДЕНО СОВПАДЕНИЕ: [${comment}] для пользователя [${foundPayment.userId}]`);
      console.log(`   paymentId: ${foundPaymentId}`);
      console.log('========================================\n');

      // Проверяем сумму (из value в нанотонах) - используем BigInt для точности
      const txValueStr = (inMsg.value || tx.value || '0').toString();
      const txValueNanoTon = BigInt(txValueStr);
      const expectedAmountTon = foundPayment.amount;
      const expectedAmountNanoTon = BigInt(tonToNanoTon(expectedAmountTon));

      // Допустимая погрешность 0.1% (для комиссий) - в нанотонах
      const toleranceNanoTon = expectedAmountNanoTon * BigInt(1000) / BigInt(1000000); // 0.1% от суммы
      const diff = txValueNanoTon > expectedAmountNanoTon 
        ? txValueNanoTon - expectedAmountNanoTon 
        : expectedAmountNanoTon - txValueNanoTon;

      if (diff > toleranceNanoTon) {
        const txAmount = nanoTonToTon(txValueStr);
        console.log(`⚠️ Несоответствие суммы: ожидается ${expectedAmountTon} TON, получено ${txAmount} TON (comment: ${comment})`);
        console.log(`   Нанотоны: получено ${txValueNanoTon.toString()}, ожидается ${expectedAmountNanoTon.toString()}, разница: ${diff.toString()}, допустимо: ${toleranceNanoTon.toString()}`);
        continue;
      }

      // Проверяем конвертацию: 1 TON = 1,000,000,000 нанотонов
      const txAmountTon = nanoTonToTon(txValueStr);
      console.log(`✅ Сумма совпадает: ${expectedAmountTon} TON (получено ${txAmountTon} TON = ${txValueNanoTon.toString()} нанотонов)`);
      console.log(`   Проверка: ${txValueNanoTon.toString()} нанотонов = ${txAmountTon} TON (должно быть ${expectedAmountTon} TON)`);

      // Всё верно! Обрабатываем платеж
      try {
        const user = await getUser(foundPayment.userId);
        const newBalance = user.games_balance + foundPayment.games;
        
        // Пополняем баланс игр
        await updateUser(foundPayment.userId, {
          games_balance: newBalance
        });

        // Получаем обновленные данные пользователя
        const updatedUser = getUser(foundPayment.userId);

        // Удаляем из pending_payments
        delete pendingPayments[foundPaymentId];

        // Добавляем в processed_tx
        processedTx[txHash] = {
          userId: foundPayment.userId,
          comment,
          amount: expectedAmountTon, // Используем expectedAmountTon (из foundPayment.amount)
          games: foundPayment.games,
          processedAt: Date.now()
        };

        // Сохраняем файлы
        await fs.writeFile(PENDING_PAYMENTS_FILE, JSON.stringify(pendingPayments, null, 2));
        await fs.writeFile(PROCESSED_TX_FILE, JSON.stringify(processedTx, null, 2));

        console.log(`✅ Платеж обработан:`);
        console.log(`   userId: ${foundPayment.userId}`);
        console.log(`   comment: ${comment}`);
        console.log(`   заплачено: ${expectedAmountTon} TON`);
        console.log(`   добавлено игр: ${foundPayment.games} (из пакета ${foundPayment.packageId})`);
        console.log(`   баланс до: ${user.games_balance}`);
        console.log(`   баланс после: ${newBalance}`);

        // Отправляем событие клиенту через Socket.io
        if (io) {
          const userRoom = `user_${foundPayment.userId}`;
          console.log(`📤 Отправляю payment_success в комнату: ${userRoom}`);
          io.to(userRoom).emit('payment_success', {
            paymentId: foundPaymentId,
            games: foundPayment.games,
            new_balance: newBalance,
            winnings_usdt: updatedUser.winnings_usdt
          });
          console.log(`✅ Событие payment_success отправлено: games=${foundPayment.games}, new_balance=${newBalance}`);
        }

      } catch (error) {
        console.error(`❌ Ошибка обработки платежа (comment: ${comment}):`, error);
      }
    }
  } catch (error) {
    console.error('❌ Ошибка сканирования транзакций:', error);
  }
}

/**
 * Инициализация конфигурации (вызывается из server.js)
 */
function initConfig(config) {
  // Жесткая проверка: если в config или .env написано 'true', то IS_TESTNET = true
  // Поддерживаем несколько вариантов: 'true', true, 'TRUE'
  const isTestnet = config.IS_TESTNET === 'true' || config.IS_TESTNET === true || config.IS_TESTNET === 'TRUE';
  
  // Жесткая проверка API_URL: если IS_TESTNET = true, то ОБЯЗАТЕЛЬНО testnet URL
  const apiUrl = isTestnet 
    ? 'https://testnet.toncenter.com/api/v2' 
    : 'https://toncenter.com/api/v2';
  
  TON_CONFIG = {
    IS_TESTNET: isTestnet,
    TON_API_URL: apiUrl,
    TON_WALLET_ADDRESS: config.TON_WALLET_ADDRESS || '',
    TON_API_KEY: config.TON_API_KEY || ''
  };
  
  console.log(`🔧 TON Config initialized:`);
  console.log(`   IS_TESTNET: ${TON_CONFIG.IS_TESTNET} (from config: ${config.IS_TESTNET})`);
  console.log(`   API_URL: ${TON_CONFIG.TON_API_URL} ${isTestnet ? '(TESTNET)' : '(MAINNET)'}`);
  console.log(`   WALLET_ADDRESS: ${TON_CONFIG.TON_WALLET_ADDRESS ? TON_CONFIG.TON_WALLET_ADDRESS.substring(0, 10) + '...' : 'NOT SET'}`);
  console.log(`   TON_API_KEY: ${TON_CONFIG.TON_API_KEY ? '***' + TON_CONFIG.TON_API_KEY.slice(-4) : 'NOT SET'}`);
  console.log(`✅ ПРОВЕРКА: API Key загружен: ${!!TON_CONFIG.TON_API_KEY}`);
}

module.exports = {
  initPaymentFiles,
  createPayment,
  scanTransactions,
  checkTonPayments, // Алиас для scanTransactions
  initConfig,
  PACKAGES,
  tonToNanoTon,
  nanoTonToTon
};
