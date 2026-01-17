/**
 * Модуль для работы с TON Testnet платежами
 * Использует TonCenter API для проверки транзакций
 */

const fs = require('fs').promises;
const path = require('path');
const { getUser, updateUser } = require('../db/users');

// Конфигурация из .env (будет загружена в server.js)
let TON_CONFIG = {
  IS_TESTNET: process.env.IS_TESTNET === 'true',
  TON_API_URL: process.env.IS_TESTNET === 'true' 
    ? 'https://testnet.toncenter.com/api/v2' 
    : 'https://toncenter.com/api/v2',
  TON_WALLET_ADDRESS: process.env.TON_WALLET_ADDRESS || '',
  TON_API_KEY: process.env.TON_API_KEY || ''
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
    const url = `${TON_CONFIG.TON_API_URL}/getTransactions?address=${address}&limit=10`;
    const headers = TON_CONFIG.TON_API_KEY 
      ? { 'X-API-Key': TON_CONFIG.TON_API_KEY }
      : {};

    const response = await fetch(url, { headers });
    
    if (!response.ok) {
      throw new Error(`TonCenter API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data.ok ? data.result : [];
  } catch (error) {
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

    // Получаем транзакции кошелька
    const transactions = await getWalletTransactions(TON_CONFIG.TON_WALLET_ADDRESS);

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
      
      if (!txHash) continue;

      // Пропускаем, если транзакция уже обработана
      if (processedTx[txHash]) {
        continue;
      }

      // Проверяем входящее сообщение (комментарий)
      const inMsg = tx.in_msg;
      if (!inMsg) continue;

      // Извлекаем комментарий из транзакции
      // TonCenter API может возвращать комментарий в разных форматах
      let comment = '';
      
      // Вариант 1: Прямое текстовое поле (если есть)
      if (inMsg.message && typeof inMsg.message === 'string') {
        try {
          // Если сообщение уже в виде строки (текст)
          if (inMsg.message.length > 0 && !inMsg.message.startsWith('0x') && !inMsg.message.match(/^[A-Za-z0-9+/=]+$/)) {
            comment = inMsg.message.trim();
          }
          // Hex формат (начинается с 0x)
          else if (inMsg.message.startsWith('0x')) {
            const hex = inMsg.message.slice(2);
            comment = Buffer.from(hex, 'hex').toString('utf8').replace(/\0/g, '').trim();
          }
          // Base64 формат
          else if (inMsg.message.match(/^[A-Za-z0-9+/=]+$/)) {
            try {
              comment = Buffer.from(inMsg.message, 'base64').toString('utf8').replace(/\0/g, '').trim();
            } catch {
              // Если не base64, пробуем как обычный текст
              comment = inMsg.message.trim();
            }
          }
        } catch (e) {
          // Если не получается декодировать, пропускаем
          console.log(`⚠️ Не удалось декодировать комментарий из in_msg.message: ${inMsg.message?.substring(0, 20)}...`);
          continue;
        }
      }
      
      // Вариант 2: Поле msg_data (если message не содержит текста)
      if ((!comment || comment.length === 0) && inMsg.msg_data) {
        try {
          // msg_data может быть hex строкой
          if (typeof inMsg.msg_data === 'string') {
            if (inMsg.msg_data.startsWith('0x')) {
              const hex = inMsg.msg_data.slice(2);
              comment = Buffer.from(hex, 'hex').toString('utf8').replace(/\0/g, '').trim();
            } else {
              comment = Buffer.from(inMsg.msg_data, 'base64').toString('utf8').replace(/\0/g, '').trim();
            }
          }
        } catch (e) {
          // Пропускаем, если не получается декодировать
        }
      }
      
      // Если комментарий все еще пустой, пропускаем транзакцию
      if (!comment || comment.length < 6) {
        continue; // Минимум 6 символов для комментария
      }

      // Если комментарий пустой, пропускаем
      if (!comment || comment.length < 8) continue;

      // Ищем платеж с таким комментарием в pending_payments
      let foundPaymentId = null;
      let foundPayment = null;

      for (const [paymentId, payment] of Object.entries(pendingPayments)) {
        if (payment.comment === comment && payment.status === 'pending') {
          foundPaymentId = paymentId;
          foundPayment = payment;
          break;
        }
      }

      if (!foundPayment) continue;

      // Проверяем сумму (из value в нанотонах)
      const txAmount = nanoTonToTon(inMsg.value || tx.value || '0');
      const expectedAmount = foundPayment.amount;

      // Допустимая погрешность 0.1% (для комиссий)
      const tolerance = expectedAmount * 0.001;
      if (Math.abs(txAmount - expectedAmount) > tolerance) {
        console.log(`⚠️ Несоответствие суммы: ожидается ${expectedAmount} TON, получено ${txAmount} TON (comment: ${comment})`);
        continue;
      }

      // Всё верно! Обрабатываем платеж
      try {
        const user = await getUser(foundPayment.userId);
        
        // Пополняем баланс игр
        await updateUser(foundPayment.userId, {
          games_balance: user.games_balance + foundPayment.games
        });

        // Удаляем из pending_payments
        delete pendingPayments[foundPaymentId];

        // Добавляем в processed_tx
        processedTx[txHash] = {
          userId: foundPayment.userId,
          comment,
          amount: expectedAmount,
          games: foundPayment.games,
          processedAt: Date.now()
        };

        // Сохраняем файлы
        await fs.writeFile(PENDING_PAYMENTS_FILE, JSON.stringify(pendingPayments, null, 2));
        await fs.writeFile(PROCESSED_TX_FILE, JSON.stringify(processedTx, null, 2));

        console.log(`✅ Платеж обработан: userId=${foundPayment.userId}, comment=${comment}, games=${foundPayment.games}`);

        // Отправляем событие клиенту через Socket.io
        if (io) {
          io.to(`user_${foundPayment.userId}`).emit('payment_success', {
            paymentId: foundPaymentId,
            games: foundPayment.games,
            new_balance: user.games_balance + foundPayment.games
          });
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
  TON_CONFIG = { ...TON_CONFIG, ...config };
  console.log(`🔧 TON Config: IS_TESTNET=${TON_CONFIG.IS_TESTNET}, API_URL=${TON_CONFIG.TON_API_URL}`);
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
