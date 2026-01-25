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
    }
    try {
      await fs.access(PROCESSED_TX_FILE);
    } catch {
      await fs.writeFile(PROCESSED_TX_FILE, JSON.stringify({}, null, 2));
    }
  } catch (error) {
    console.error('Init payment files error:', error.message);
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
 * Пакеты игр (1 TON = 1 игра, 5 TON = 5 игр, 10 TON = 10 игр)
 * Все расчеты в TON
 */
const PACKAGES = {
  pkg_1: { amount: 1, games: 1, priceUsd: 1 },    // 1 TON = 1 игра
  pkg_5: { amount: 5, games: 5, priceUsd: 5 },    // 5 TON = 5 игр
  pkg_10: { amount: 10, games: 10, priceUsd: 10 }  // 10 TON = 10 игр
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
 * Создание депозита (любая сумма)
 * @param {number} userId - ID пользователя
 * @param {number} amount - Сумма депозита в TON
 * @returns {Promise<Object>} - Данные платежа (comment, amount в нанотонах)
 */
async function createDeposit(userId, amount) {
  try {
    if (!amount || amount <= 0) {
      return {
        success: false,
        error: 'Invalid deposit amount'
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

    // Создаем запись о депозите
    const paymentId = `deposit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    pendingPayments[paymentId] = {
      userId,
      type: 'deposit',
      comment,
      amount: amount, // TON
      createdAt: Date.now(),
      status: 'pending'
    };

    // Сохраняем в файл
    await fs.writeFile(PENDING_PAYMENTS_FILE, JSON.stringify(pendingPayments, null, 2));

    console.log(`💰 Создан депозит: userId=${userId}, amount=${amount} TON, comment=${comment}`);

    return {
      success: true,
      paymentId,
      comment,
      amount: tonToNanoTon(amount), // Возвращаем в нанотонах для Deep Link
      amountTon: amount, // Возвращаем в TON для отображения
      walletAddress: TON_CONFIG.TON_WALLET_ADDRESS
    };
  } catch (error) {
    console.error('Create deposit error:', error.message);
    return { success: false, error: error.message };
  }
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
    console.error('Create payment error:', error.message);
    return { success: false, error: error.message };
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
    return data.ok ? data.result : [];
  } catch (error) {
    if (error.response?.status === 429) return [];
    console.error('getWalletTransactions error:', error.message);
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
    
    // Читаем pending_payments для проверки, есть ли ожидающие платежи
    let pendingPayments = {};
    try {
      const data = await fs.readFile(PENDING_PAYMENTS_FILE, 'utf8');
      pendingPayments = JSON.parse(data);
    } catch {
      pendingPayments = {};
    }
    
    const transactions = await getWalletTransactions(walletAddress);

    // Читаем processed_tx.json (обработанные транзакции)
    let processedTx = {};
    try {
      const data = await fs.readFile(PROCESSED_TX_FILE, 'utf8');
      processedTx = JSON.parse(data);
    } catch {
      processedTx = {};
    }

    // Читаем pending_payments.json (ожидающие платежи) - уже прочитано выше, но перечитываем для актуальности
    try {
      const data = await fs.readFile(PENDING_PAYMENTS_FILE, 'utf8');
      pendingPayments = JSON.parse(data);
    } catch {
      pendingPayments = {};
    }
    
    // Обрабатываем каждую транзакцию
    // Операции внутри цикла асинхронные (await), поэтому не блокируют event loop
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
      
      // Извлекаем комментарий из транзакции
      let extractedComment = '';
      
      // Функция проверки валидного Base64
      function isBase64(str) {
        if (!str || typeof str !== 'string') return false;
        // Base64 должна содержать только: A-Z, a-z, 0-9, +, /, =
        const base64Pattern = /^[A-Za-z0-9+/]+=*$/;
        return base64Pattern.test(str) && str.length >= 4;
      }
      
      // Упрощенная функция декодирования TON комментария из Base64
      function decodeTonCommentFromBase64(base64String) {
        if (!base64String || typeof base64String !== 'string') {
          return null;
        }
        
        try {
          // 1. Переводим Base64 в Buffer
          const buffer = Buffer.from(base64String.trim(), 'base64');
          
          // 2. Проверяем первые 4 байта (префикс текстового сообщения в TON = 0x00000000)
          if (buffer.length >= 4) {
            const prefix = buffer.readUInt32BE(0);
            
            if (prefix === 0x00000000) {
              // 3. Если первые 4 байта равны 0, удаляем их
              const textBuffer = buffer.slice(4);
              // 4. Оставшуюся часть Buffer переводим в строку UTF-8
              const decoded = textBuffer.toString('utf-8');
              console.log(`✅ [SCANNER] Декодирован комментарий из Base64 (префикс удален): "${decoded}"`);
              return decoded;
            } else {
              // Если префикс не 0x00000000, пробуем декодировать весь буфер
              const decoded = buffer.toString('utf-8');
              // Проверяем, что это валидный текст (не битые байты)
              if (decoded && !decoded.includes('\ufffd') && /^[A-Za-z0-9]+$/.test(decoded)) {
                return decoded;
              }
            }
          } else {
            // Буфер слишком короткий - пробуем декодировать как есть
            const decoded = buffer.toString('utf-8');
            if (decoded && !decoded.includes('\ufffd') && /^[A-Za-z0-9]+$/.test(decoded)) {
              return decoded;
            }
          }
        } catch (error) {
          return null;
        }
        
        return null;
      }
      
      // ПРИОРИТЕТ 1: Проверяем msg_data
      if (inMsg.msg_data) {
        if (inMsg.msg_data.text && typeof inMsg.msg_data.text === 'string') {
          const text = inMsg.msg_data.text.trim();
          if (/^[A-Za-z0-9]{4,20}$/.test(text)) {
            extractedComment = text;
          } else if (!isBase64(text) && !text.startsWith('0x') && !/^[0-9a-fA-F]+$/i.test(text)) {
            extractedComment = text;
          } else if (isBase64(text)) {
            const decoded = decodeTonCommentFromBase64(text);
            if (decoded) extractedComment = decoded;
          } else {
            extractedComment = text;
          }
        }
        if (!extractedComment && inMsg.msg_data.body) {
          const body = typeof inMsg.msg_data.body === 'string' ? inMsg.msg_data.body.trim() : inMsg.msg_data.body;
          if (typeof body === 'string' && isBase64(body)) {
            const decoded = decodeTonCommentFromBase64(body);
            if (decoded) extractedComment = decoded;
          } else if (typeof body === 'string') {
            extractedComment = body;
          }
        }
      }
      if (!extractedComment && inMsg.message && typeof inMsg.message === 'string') {
        const message = inMsg.message.trim();
        if (/^[A-Za-z0-9]{4,20}$/.test(message)) {
          extractedComment = message;
        } else if (isBase64(message)) {
          const decoded = decodeTonCommentFromBase64(message);
          if (decoded) extractedComment = decoded;
        } else {
          extractedComment = message;
        }
      }

      const comment = extractedComment ? extractedComment.trim().toUpperCase() : '';
      if (!comment || comment.length === 0) continue;
      
      // Ищем платеж с таким комментарием в pending_payments
      let foundPaymentId = null;
      let foundPayment = null;

      // Точное совпадение: сравниваем комментарий с базой
      for (const [paymentId, payment] of Object.entries(pendingPayments)) {
        const expectedComment = (payment.comment || '').trim().toUpperCase();
        if (comment === expectedComment && payment.status === 'pending') {
          foundPaymentId = paymentId;
          foundPayment = payment;
          break;
        }
      }
      if (foundPayment && !foundPayment.games && foundPayment.type !== 'deposit') continue;

      if (!foundPayment && comment && Object.keys(pendingPayments).length > 0 && inMsg.msg_data?.text) {
        const pendingComments = Object.values(pendingPayments).map(p => (p.comment || '').toUpperCase().trim());
        const directText = inMsg.msg_data.text.trim();
        if (directText && !isBase64(directText) && !directText.startsWith('0x') && !/^[0-9a-fA-F]+$/i.test(directText)) {
          const directComment = directText.toUpperCase().trim();
          if (pendingComments.includes(directComment)) {
            for (const [paymentId, payment] of Object.entries(pendingPayments)) {
              const expectedComment = (payment.comment || '').toUpperCase().trim();
              if (directComment === expectedComment && payment.status === 'pending') {
                foundPaymentId = paymentId;
                foundPayment = payment;
                break;
              }
            }
          }
        }
      }

      if (!foundPayment) continue;

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

      if (diff > toleranceNanoTon) continue;

      // Всё верно! Обрабатываем платеж
      try {
        const user = await getUser(foundPayment.userId);
        
        // Проверяем тип платежа: депозит или покупка игр
        if (foundPayment.type === 'deposit') {
          // Депозит: добавляем в winnings_ton
          const newWinnings = (user.winnings_ton || 0) + expectedAmountTon;
          
          await updateUser(foundPayment.userId, {
            winnings_ton: newWinnings
          });

          const updatedUser = await getUser(foundPayment.userId);

          // Удаляем из pending_payments
          delete pendingPayments[foundPaymentId];

          // Добавляем в processed_tx
          processedTx[txHash] = {
            userId: foundPayment.userId,
            comment,
            amount: expectedAmountTon,
            type: 'deposit',
            processedAt: Date.now()
          };

          // Сохраняем файлы
          await fs.writeFile(PENDING_PAYMENTS_FILE, JSON.stringify(pendingPayments, null, 2));
          await fs.writeFile(PROCESSED_TX_FILE, JSON.stringify(processedTx, null, 2));

          if (io) {
            io.to(`user_${foundPayment.userId}`).emit('deposit_success', {
              paymentId: foundPaymentId,
              amount: expectedAmountTon,
              new_winnings: newWinnings,
              games_balance: updatedUser.games_balance
            });
          }
        } else {
          // Покупка игр: добавляем в games_balance
          const newBalance = user.games_balance + (foundPayment.games || 0);
          
          await updateUser(foundPayment.userId, {
            games_balance: newBalance
          });

          const updatedUser = await getUser(foundPayment.userId);

          // Удаляем из pending_payments
          delete pendingPayments[foundPaymentId];

          // Добавляем в processed_tx
          processedTx[txHash] = {
            userId: foundPayment.userId,
            comment,
            amount: expectedAmountTon,
            games: foundPayment.games,
            processedAt: Date.now()
          };

          // Сохраняем файлы
          await fs.writeFile(PENDING_PAYMENTS_FILE, JSON.stringify(pendingPayments, null, 2));
          await fs.writeFile(PROCESSED_TX_FILE, JSON.stringify(processedTx, null, 2));

          if (io) {
            io.to(`user_${foundPayment.userId}`).emit('payment_success', {
              paymentId: foundPaymentId,
              games: foundPayment.games,
              new_balance: newBalance,
              winnings_ton: updatedUser.winnings_ton
            });
          }
        }

      } catch (error) {
        console.error('Payment processing error:', error.message);
      }
    }
  } catch (error) {
    console.error('Scan transactions error:', error.message);
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
}

module.exports = {
  initPaymentFiles,
  createPayment,
  createDeposit,
  scanTransactions,
  checkTonPayments, // Алиас для scanTransactions
  initConfig,
  PACKAGES,
  tonToNanoTon,
  nanoTonToTon
};
