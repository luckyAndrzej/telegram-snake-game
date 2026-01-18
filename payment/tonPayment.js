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
    const url = `${TON_CONFIG.TON_API_URL}/getTransactions?address=${address}&limit=10`;
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
    
    if (!response.ok) {
      throw new Error(`TonCenter API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    console.log(`📊 TonCenter API response: ok=${data.ok}, transactions count=${data.result?.length || 0}`);
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

    const walletAddress = TON_CONFIG.TON_WALLET_ADDRESS;
    console.log(`🔍 Проверяю транзакции для кошелька: ${walletAddress}`);
    console.log(`   Используется API: ${TON_CONFIG.TON_API_URL}`);

    // Получаем транзакции кошелька
    const transactions = await getWalletTransactions(walletAddress);
    
    console.log(`📊 Получено транзакций: ${transactions.length}`);

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
        console.log('⚠️ Транзакция без хеша, пропускаем');
        continue;
      }

      // Пропускаем, если транзакция уже обработана
      if (processedTx[txHash]) {
        continue;
      }

      // Логирование каждой найденной транзакции
      const txComment = tx.in_msg?.message || tx.in_msg?.msg_data?.text || 'нет комментария';
      console.log(`📨 Найдена транзакция: ${txHash.substring(0, 10)}... с комментарием: ${typeof txComment === 'string' ? txComment : JSON.stringify(txComment)}`);

      // Логирование полной структуры транзакции для отладки
      console.log('📨 Full transaction data:', JSON.stringify(tx, null, 2));

      // Проверяем входящее сообщение (комментарий)
      const inMsg = tx.in_msg;
      if (!inMsg) {
        console.log('⚠️ Транзакция без in_msg, пропускаем');
        continue;
      }

      // Извлекаем комментарий из транзакции
      // Умная функция проверки валидного Base64
      function isBase64(str) {
        if (!str || typeof str !== 'string') return false;
        // Base64 должна содержать только: A-Z, a-z, 0-9, +, /, =
        const base64Pattern = /^[A-Za-z0-9+/]+=*$/;
        if (!base64Pattern.test(str)) return false;
        // Длина должна быть кратна 4 (после padding)
        const cleanStr = str.replace(/=+$/, '');
        return cleanStr.length % 4 === 0;
      }
      
      // Функция проверки, является ли строка читаемым текстом (не бинарным мусором)
      function isReadableText(str) {
        if (!str) return false;
        // Проверяем, что строка содержит хотя бы 50% печатаемых ASCII символов
        const printableChars = str.match(/[\x20-\x7E]/g) || [];
        return printableChars.length >= str.length * 0.5 && str.length >= 3;
      }
      
      let extractedComment = '';
      
      // ПРИОРИТЕТ 1: Проверяем in_msg.message как обычную строку (не Base64 и не Hex)
      if (inMsg.message && typeof inMsg.message === 'string') {
        const trimmed = inMsg.message.trim();
        // Если это НЕ Base64 и НЕ Hex, используем как обычный текст
        if (!trimmed.startsWith('0x') && !isBase64(trimmed)) {
          extractedComment = trimmed;
          console.log(`🔍 Извлечено из in_msg.message (обычный текст): "${extractedComment}"`);
        }
      }
      
      // ПРИОРИТЕТ 2: Если msg_data.text существует, используем его
      if ((!extractedComment || extractedComment.length === 0) && inMsg.msg_data) {
        try {
          // Проверяем msg_data.text
          if (inMsg.msg_data.text && typeof inMsg.msg_data.text === 'string') {
            const trimmed = inMsg.msg_data.text.trim();
            // Если это НЕ Base64 и НЕ Hex, используем как обычный текст
            if (!trimmed.startsWith('0x') && !isBase64(trimmed)) {
              extractedComment = trimmed;
              console.log(`🔍 Извлечено из msg_data.text (обычный текст): "${extractedComment}"`);
            }
          }
        } catch (e) {
          console.log(`⚠️ Ошибка при чтении in_msg.msg_data.text:`, e.message);
        }
      }
      
      // ПРИОРИТЕТ 3: Умное декодирование Base64/Hex (только если еще не нашли обычный текст)
      if (!extractedComment || extractedComment.length === 0) {
        // Пробуем декодировать из in_msg.message (если это Base64/Hex)
        if (inMsg.message && typeof inMsg.message === 'string') {
          const trimmed = inMsg.message.trim();
          try {
            if (trimmed.startsWith('0x')) {
              // Hex формат
              const hex = trimmed.slice(2);
              const decoded = Buffer.from(hex, 'hex').toString('utf-8').replace(/\0/g, '');
              if (isReadableText(decoded)) {
                extractedComment = decoded;
                console.log(`✅ Декодирован Hex из in_msg.message: "${trimmed}" -> "${extractedComment}"`);
              } else {
                console.log(`⚠️ Декодированный Hex содержит бинарный мусор, отбрасываем`);
              }
            } else if (isBase64(trimmed)) {
              // Base64 формат
              const decoded = Buffer.from(trimmed, 'base64').toString('utf-8').replace(/\0/g, '');
              if (isReadableText(decoded)) {
                extractedComment = decoded;
                console.log(`✅ Декодирован Base64 из in_msg.message: "${trimmed}" -> "${extractedComment}"`);
              } else {
                console.log(`⚠️ Декодированный Base64 содержит бинарный мусор, отбрасываем`);
              }
            }
          } catch (decodeError) {
            console.log(`⚠️ Ошибка декодирования in_msg.message:`, decodeError.message);
          }
        }
        
        // Пробуем декодировать из msg_data (если это Base64/Hex)
        if ((!extractedComment || extractedComment.length === 0) && inMsg.msg_data) {
          try {
            if (typeof inMsg.msg_data === 'string') {
              const trimmed = inMsg.msg_data.trim();
              if (trimmed.startsWith('0x')) {
                const hex = trimmed.slice(2);
                const decoded = Buffer.from(hex, 'hex').toString('utf-8').replace(/\0/g, '');
                if (isReadableText(decoded)) {
                  extractedComment = decoded;
                  console.log(`✅ Декодирован Hex из msg_data: "${trimmed}" -> "${extractedComment}"`);
                }
              } else if (isBase64(trimmed)) {
                const decoded = Buffer.from(trimmed, 'base64').toString('utf-8').replace(/\0/g, '');
                if (isReadableText(decoded)) {
                  extractedComment = decoded;
                  console.log(`✅ Декодирован Base64 из msg_data: "${trimmed}" -> "${extractedComment}"`);
                }
              }
            } else if (inMsg.msg_data.text && typeof inMsg.msg_data.text === 'string') {
              const trimmed = inMsg.msg_data.text.trim();
              if (trimmed.startsWith('0x')) {
                const hex = trimmed.slice(2);
                const decoded = Buffer.from(hex, 'hex').toString('utf-8').replace(/\0/g, '');
                if (isReadableText(decoded)) {
                  extractedComment = decoded;
                  console.log(`✅ Декодирован Hex из msg_data.text: "${trimmed}" -> "${extractedComment}"`);
                }
              } else if (isBase64(trimmed)) {
                const decoded = Buffer.from(trimmed, 'base64').toString('utf-8').replace(/\0/g, '');
                if (isReadableText(decoded)) {
                  extractedComment = decoded;
                  console.log(`✅ Декодирован Base64 из msg_data.text: "${trimmed}" -> "${extractedComment}"`);
                }
              }
            }
          } catch (decodeError) {
            console.log(`⚠️ Ошибка декодирования msg_data:`, decodeError.message);
          }
        }
      }
      
      // Очистка от мусора (невидимых символов) и нормализация
      // Удаляем все символы, которые не являются печатаемыми ASCII (0x20-0x7E)
      // Затем переводим в UPPERCASE для сравнения
      const finalComment = extractedComment 
        ? extractedComment.replace(/[^\x20-\x7E]/g, '').trim().toUpperCase()
        : '';
      
      console.log(`🔍 Исходный комментарий: "${extractedComment}"`);
      console.log(`🔍 Финальный комментарий (после очистки): "${finalComment}"`);
      
      // Используем финальный комментарий для дальнейшей обработки
      const comment = finalComment;
      
      // Если комментарий все еще пустой, пропускаем транзакцию
      // Ищем платеж с таким комментарием в pending_payments
      // Комментарии уже нормализованы в UPPERCASE
      let foundPaymentId = null;
      let foundPayment = null;
      const pendingComments = Object.values(pendingPayments).map(p => (p.comment || '').toUpperCase().trim());

      // Логирование перед сравнением
      console.log(`🔍 Final Decoded Comment: [${comment}] Looking for: [${pendingComments.join(', ')}]`);

      // Точное совпадение: сравниваем очищенный комментарий с базой
      for (const [paymentId, payment] of Object.entries(pendingPayments)) {
        const paymentComment = (payment.comment || '').toUpperCase().trim();
        if (paymentComment === comment && payment.status === 'pending') {
          foundPaymentId = paymentId;
          foundPayment = payment;
          break;
        }
      }
      
      // Если комментарий пустой, но не нашли совпадение - пропускаем
      if (!comment || comment.length === 0) {
        console.log('⚠️ Транзакция без комментария');
        continue;
      }

      if (!foundPayment) {
        console.log(`⚠️ Найден комментарий: "${comment}", а ожидаем: [${pendingComments.join(', ')}]`);
        console.log(`📋 Все pending_payments:`, Object.keys(pendingPayments).map(id => ({
          id,
          comment: pendingPayments[id].comment,
          status: pendingPayments[id].status
        })));
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
            new_balance: newBalance
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
