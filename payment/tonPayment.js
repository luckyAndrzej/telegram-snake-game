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
      
      // ДИАГНОСТИКА: Логируем структуру in_msg для отладки (только для первых транзакций)
      if (Object.keys(pendingPayments).length > 0) {
        console.log(`🔍 [Сканер] Структура in_msg:`, {
          hasMessage: !!inMsg.message,
          hasMsgData: !!inMsg.msg_data,
          msgDataKeys: inMsg.msg_data ? Object.keys(inMsg.msg_data) : [],
          messagePreview: inMsg.message ? inMsg.message.substring(0, 50) : null,
          msgDataTextPreview: inMsg.msg_data?.text ? inMsg.msg_data.text.substring(0, 50) : null,
          msgDataBodyPreview: inMsg.msg_data?.body ? (typeof inMsg.msg_data.body === 'string' ? inMsg.msg_data.body.substring(0, 50) : 'not string') : null
        });
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
      
      // Функция декодирования TON комментария из body (Base64/Hex)
      function decodeTonComment(bodyData) {
        if (!bodyData) {
          console.log(`⚠️ [Декодер] bodyData пустой или null`);
          return null;
        }
        
        try {
          let buffer;
          
          // Определяем формат: Base64 или Hex
          if (typeof bodyData === 'string') {
            const trimmed = bodyData.trim();
            
            if (trimmed.startsWith('0x') || /^[0-9a-fA-F]+$/i.test(trimmed)) {
              // Hex формат
              const hexStr = trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed;
              console.log(`🔍 [Декодер] Определен Hex формат, длина: ${hexStr.length} символов`);
              buffer = Buffer.from(hexStr, 'hex');
            } else if (isBase64(trimmed)) {
              // Base64 формат
              console.log(`🔍 [Декодер] Определен Base64 формат, длина: ${trimmed.length} символов`);
              buffer = Buffer.from(trimmed, 'base64');
            } else {
              // Уже текст - проверяем, не содержит ли битых байт
              if (trimmed.includes('\ufffd')) {
                console.log(`⚠️ [Декодер] Текст содержит битые байты, пробуем декодировать как Base64...`);
                // Может быть, это Base64, но проверка не сработала
                try {
                  buffer = Buffer.from(trimmed, 'base64');
                } catch {
                  return null;
                }
              } else {
                console.log(`✅ [Декодер] Используем как обычный текст: "${trimmed}"`);
                return trimmed;
              }
            }
          } else if (Buffer.isBuffer(bodyData)) {
            // Уже буфер
            buffer = bodyData;
            console.log(`🔍 [Декодер] Получен Buffer, размер: ${buffer.length} байт`);
          } else {
            console.log(`⚠️ [Декодер] Неизвестный тип bodyData: ${typeof bodyData}`);
            return null;
          }
          
          // Проверяем префикс TON для текстовых комментариев (4 нулевых байта: 00000000)
          // В TON текстовые комментарии начинаются с 32-битного префикса 0x00000000
          console.log(`🔍 [Декодер] Размер буфера: ${buffer.length} байт`);
          
          if (buffer.length >= 4) {
            const prefix = buffer.readUInt32BE(0);
            const prefixHex = buffer.slice(0, 4).toString('hex');
            console.log(`🔍 [Декодер] Префикс (первые 4 байта): 0x${prefixHex} (uint32: ${prefix})`);
            
            if (prefix === 0x00000000) {
              // Это текстовый комментарий TON - отрезаем префикс и декодируем UTF-8
              const textBuffer = buffer.slice(4);
              const decoded = textBuffer.toString('utf-8');
              console.log(`✅ [Декодер] Найден TON префикс 0x00000000, декодировано: "${decoded}"`);
              return decoded;
            } else {
              // Нет префикса 0x00000000 - пробуем разные варианты
              // ВАРИАНТ 1: Пробуем отрезать первые 4 байта вручную (может быть другой префикс)
              if (buffer.length > 4) {
                const textBuffer = buffer.slice(4);
                const decodedWithSlice = textBuffer.toString('utf-8');
                // Проверяем, что это валидный текст (не битые байты) и содержит только печатаемые символы
                if (decodedWithSlice && !decodedWithSlice.includes('\ufffd') && /^[A-Za-z0-9]+$/.test(decodedWithSlice)) {
                  console.log(`✅ [Декодер] Декодировано после отрезания первых 4 байт: "${decodedWithSlice}"`);
                  return decodedWithSlice;
                }
              }
              
              // ВАРИАНТ 2: Пробуем декодировать весь буфер как UTF-8
              const decoded = buffer.toString('utf-8');
              // Проверяем, что это валидный текст (не битые байты) и содержит только печатаемые символы
              if (decoded && !decoded.includes('\ufffd') && /^[A-Za-z0-9]+$/.test(decoded)) {
                console.log(`✅ [Декодер] Декодировано без префикса: "${decoded}"`);
                return decoded;
              } else {
                console.log(`⚠️ [Декодер] Обнаружены битые байты или невалидные символы в декодированном тексте: "${decoded}"`);
                
                // ВАРИАНТ 3: Если буфер ровно 8 байт (комментарий 8 символов + 4 байта префикса), пробуем разные варианты
                if (buffer.length === 8) {
                  // Пробуем отрезать первые 4 байта
                  const slice4 = buffer.slice(4).toString('utf-8');
                  if (slice4 && !slice4.includes('\ufffd') && /^[A-Za-z0-9]+$/.test(slice4)) {
                    console.log(`✅ [Декодер] Декодировано из 8-байтного буфера (отрезано 4 байта): "${slice4}"`);
                    return slice4;
                  }
                  
                  // Пробуем отрезать последние 4 байта (может быть суффикс)
                  const sliceLast4 = buffer.slice(0, 4).toString('utf-8');
                  if (sliceLast4 && !sliceLast4.includes('\ufffd') && /^[A-Za-z0-9]+$/.test(sliceLast4)) {
                    console.log(`✅ [Декодер] Декодировано из 8-байтного буфера (первые 4 байта): "${sliceLast4}"`);
                    return sliceLast4;
                  }
                }
              }
            }
          } else {
            // Буфер слишком короткий - пробуем декодировать как есть
            const decoded = buffer.toString('utf-8');
            console.log(`⚠️ [Декодер] Буфер слишком короткий (${buffer.length} байт), декодировано как есть: "${decoded}"`);
            return decoded;
          }
        } catch (error) {
          console.error('❌ Ошибка декодирования TON комментария:', error);
          return null;
        }
        
        return null;
      }
      
      // ПРИОРИТЕТ 1: Проверяем msg_data
      if (inMsg.msg_data) {
        console.log(`🔍 [Сканер] msg_data найден:`, {
          hasText: !!inMsg.msg_data.text,
          hasBody: !!inMsg.msg_data.body,
          textType: typeof inMsg.msg_data.text,
          bodyType: typeof inMsg.msg_data.body,
          msgDataKeys: Object.keys(inMsg.msg_data)
        });
        
        // ДОПОЛНИТЕЛЬНАЯ ПРОВЕРКА: Может быть комментарий в других полях msg_data
        if (inMsg.msg_data.op) {
          console.log(`🔍 [Сканер] msg_data.op найден: ${inMsg.msg_data.op}`);
        }
        if (inMsg.msg_data.init) {
          console.log(`🔍 [Сканер] msg_data.init найден`);
        }
        
        // Если msg_data.text существует и это текст
        if (inMsg.msg_data.text && typeof inMsg.msg_data.text === 'string') {
          const text = inMsg.msg_data.text.trim();
          console.log(`📄 [Сканер] msg_data.text: "${text.substring(0, 50)}..." (длина: ${text.length})`);
          
          // Если это не Base64 и не Hex, используем как текст
          if (!isBase64(text) && !text.startsWith('0x') && !/^[0-9a-fA-F]+$/i.test(text)) {
            extractedComment = text;
            console.log(`✅ [Сканер] Используем msg_data.text как обычный текст: "${extractedComment}"`);
          } else {
            // Пробуем декодировать из Base64/Hex
            console.log(`🔄 [Сканер] Декодируем msg_data.text из Base64/Hex...`);
            const decoded = decodeTonComment(text);
            if (decoded) {
              extractedComment = decoded;
              console.log(`✅ [Сканер] Декодировано из msg_data.text: "${extractedComment}"`);
            } else {
              console.log(`⚠️ [Сканер] Не удалось декодировать msg_data.text, пробуем как обычный текст...`);
              // Fallback: пробуем использовать как есть, если это похоже на валидный комментарий
              if (/^[A-Za-z0-9]+$/.test(text) && text.length >= 4 && text.length <= 20) {
                extractedComment = text;
                console.log(`✅ [Сканер] Используем msg_data.text как комментарий напрямую: "${extractedComment}"`);
              }
            }
          }
        }
        
        // Если msg_data.body существует (бинарные данные)
        if (!extractedComment && inMsg.msg_data.body) {
          const body = typeof inMsg.msg_data.body === 'string' 
            ? inMsg.msg_data.body.trim() 
            : inMsg.msg_data.body;
          console.log(`📦 [Сканер] msg_data.body найден, тип: ${typeof body}, длина: ${typeof body === 'string' ? body.length : 'N/A'}`);
          
          // Пробуем декодировать body
          const decoded = decodeTonComment(body);
          if (decoded) {
            extractedComment = decoded;
            console.log(`✅ [Сканер] Декодировано из msg_data.body: "${extractedComment}"`);
          } else {
            console.log(`⚠️ [Сканер] Не удалось декодировать msg_data.body`);
            
            // ДОПОЛНИТЕЛЬНАЯ ПРОВЕРКА: Может быть комментарий в начале body после префикса
            // Пробуем найти комментарий в разных частях body
            if (typeof body === 'string' && isBase64(body)) {
              try {
                const bodyBuffer = Buffer.from(body, 'base64');
                // Пробуем разные смещения для поиска комментария
                for (let offset = 0; offset < Math.min(32, bodyBuffer.length - 8); offset += 4) {
                  const slice = bodyBuffer.slice(offset, offset + 8);
                  const decodedSlice = slice.toString('utf-8');
                  if (decodedSlice && !decodedSlice.includes('\ufffd') && /^[A-Za-z0-9]{4,8}$/.test(decodedSlice)) {
                    console.log(`🔍 [Сканер] Найден возможный комментарий в body (offset ${offset}): "${decodedSlice}"`);
                    // Проверяем, совпадает ли с ожидаемым
                    const pendingComments = Object.values(pendingPayments).map(p => (p.comment || '').toUpperCase().trim());
                    if (pendingComments.includes(decodedSlice.toUpperCase())) {
                      extractedComment = decodedSlice;
                      console.log(`✅ [Сканер] Найден комментарий в body (offset ${offset}): "${extractedComment}"`);
                      break;
                    }
                  }
                }
              } catch (e) {
                console.log(`⚠️ [Сканер] Ошибка при поиске комментария в body: ${e.message}`);
              }
            }
          }
        }
      } else {
        console.log(`⚠️ [Сканер] msg_data отсутствует в in_msg`);
      }
      
      // ПРИОРИТЕТ 2: Если не нашли в msg_data, проверяем in_msg.message
      if (!extractedComment && inMsg.message && typeof inMsg.message === 'string') {
        const message = inMsg.message.trim();
        console.log(`📨 [Сканер] in_msg.message: "${message.substring(0, 50)}..." (длина: ${message.length})`);
        
        // Если это не Base64 и не Hex, используем как текст
        if (!isBase64(message) && !message.startsWith('0x') && !/^[0-9a-fA-F]+$/.test(message)) {
          extractedComment = message;
          console.log(`✅ [Сканер] Используем in_msg.message как обычный текст: "${extractedComment}"`);
        } else {
          // Пробуем декодировать из Base64/Hex
          console.log(`🔄 [Сканер] Декодируем in_msg.message из Base64/Hex...`);
          const decoded = decodeTonComment(message);
          if (decoded) {
            extractedComment = decoded;
            console.log(`✅ [Сканер] Декодировано из in_msg.message: "${extractedComment}"`);
          } else {
            console.log(`⚠️ [Сканер] Не удалось декодировать in_msg.message`);
          }
        }
      }
      
      // Нормализация: ТОЛЬКО trim() и toUpperCase(), без других замен
      const comment = extractedComment ? extractedComment.trim().toUpperCase() : '';
      
      // ЛОГИРОВАНИЕ: Выводим финальный декодированный текст для отладки
      if (comment) {
        console.log(`📝 [Сканер] Декодированный комментарий: "${comment}" (длина: ${comment.length})`);
      }

      // Если комментарий пустой, пропускаем транзакцию
      if (!comment || comment.length === 0) {
        continue;
      }
      
      // Ищем платеж с таким комментарием в pending_payments
      let foundPaymentId = null;
      let foundPayment = null;

      // Точное совпадение: сравниваем комментарий с базой
      for (const [paymentId, payment] of Object.entries(pendingPayments)) {
        const expectedComment = (payment.comment || '').toUpperCase().trim();
        
        // Проверка: если decoded_comment.trim().toUpperCase() === expected_comment.toUpperCase()
        if (comment === expectedComment && payment.status === 'pending') {
          foundPaymentId = paymentId;
          foundPayment = payment;
          console.log(`✅ [Сканер] Найдено совпадение комментариев: "${comment}" === "${expectedComment}"`);
          break;
        }
      }
      
      // ДОПОЛНИТЕЛЬНАЯ ПРОВЕРКА: Если не нашли совпадение, пробуем найти комментарий в других местах
      if (!foundPayment && comment && Object.keys(pendingPayments).length > 0) {
        console.log(`⚠️ [Сканер] Комментарий "${comment}" не совпал с ожидаемыми. Пробуем альтернативные варианты...`);
        
        // Пробуем искать комментарий в разных частях структуры
        const pendingComments = Object.values(pendingPayments).map(p => (p.comment || '').toUpperCase().trim());
        
        // Проверяем, может быть комментарий закодирован по-другому
        // Пробуем декодировать msg_data.text как есть (без Base64 декодирования)
        if (inMsg.msg_data?.text) {
          const directText = inMsg.msg_data.text.trim();
          if (directText && !isBase64(directText) && !directText.startsWith('0x') && !/^[0-9a-fA-F]+$/i.test(directText)) {
            const directComment = directText.toUpperCase().trim();
            if (pendingComments.includes(directComment)) {
              console.log(`✅ [Сканер] Найден комментарий напрямую в msg_data.text: "${directComment}"`);
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
      }
      
      // Логируем все ожидаемые комментарии для отладки
      const pendingComments = Object.values(pendingPayments).map(p => (p.comment || '').toUpperCase().trim());
      if (pendingComments.length > 0) {
        console.log(`🔍 [Сканер] Ожидаемые комментарии: [${pendingComments.join(', ')}]`);
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
            winnings_ton: updatedUser.winnings_ton
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
