# 📊 Анализ потока обновления баланса

## Проблема
После оплаты игры или после победы в матче баланс в интерфейсе остается 0.

---

## 🔍 УЗЕЛ 1: Логика завершения игры (endGame)

**Файл:** `server.js` (строки 497-663)

### Код начисления выигрыша:

```javascript
async function endGame(gameId, winnerId, loserId) {
  // ... проверки ...
  
  const winAmount = 1.75;
  let prize = 0;
  
  if (winnerId) {
    if (game.tick_number === 0 || !game.tick_number) {
      prize = 0;
    } else {
      try {
        // ✅ ПРЯМОЕ ЧТЕНИЕ users.json
        const fs = require('fs');
        const dbPath = path.join(__dirname, 'db', 'db.json');
        const dbData = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        const usersData = dbData.users || {};
        
        // ✅ ПОИСК ПОБЕДИТЕЛЯ (приведение к строке)
        const winnerIdStr = String(winnerId);
        const winner = usersData[winnerIdStr];
        
        if (winner && winner.tg_id) {
          // ✅ ОБНОВЛЕНИЕ БАЛАНСА
          const oldWinnings = winner.winnings_usdt || 0;
          const newWinnings = oldWinnings + winAmount;
          const newTotalEarned = (winner.totalEarned || 0) + winAmount;
          
          usersData[winnerIdStr].winnings_usdt = newWinnings;
          usersData[winnerIdStr].totalEarned = newTotalEarned;
          
          // ✅ ПРИНУДИТЕЛЬНОЕ СОХРАНЕНИЕ через fs.writeFileSync
          const dbDataToSave = { users: usersData };
          fs.writeFileSync(dbPath, JSON.stringify(dbDataToSave, null, 2), 'utf8');
          
          prize = winAmount;
          
          // ✅ ЛОГИРОВАНИЕ
          console.log(`💰 ВЫИГРЫШ ЗАЧИСЛЕН: Игрок ${winnerId}, новый баланс: ${newWinnings}`);
          
          // ✅ ОБНОВЛЕНИЕ В LOWDB (синхронизация)
          updateUser(winnerId, {
            winnings_usdt: newWinnings,
            totalEarned: newTotalEarned
          });
          
          // ✅ ОТПРАВКА СОБЫТИЙ КЛИЕНТУ
          const updatedUser = getUser(winnerId);
          io.to(`user_${winnerId}`).emit('balance_updated', {
            games_balance: updatedUser.games_balance,
            winnings_usdt: updatedUser.winnings_usdt
          });
          io.to(`user_${winnerId}`).emit('updateBalance', winAmount);
        }
      } catch (error) {
        console.error(`❌ Ошибка при начислении приза:`, error);
        prize = 0;
      }
    }
  }
  
  // ✅ ОТПРАВКА game_end с prize
  if (!game.end_event_sent) {
    const eventData = {
      winnerId,
      prize: prize, // 1.75 если есть победитель
      game_stats: { ... }
    };
    io.to(roomName).emit('game_end', eventData);
  }
}
```

### ✅ Проверки:
- [x] `fs.writeFileSync()` вызывается после обновления баланса
- [x] `winnerId` приводится к строке: `String(winnerId)`
- [x] `prize` устанавливается в `1.75` и отправляется в `game_end`
- [x] События `balance_updated` и `updateBalance` отправляются клиенту

---

## 🔍 УЗЕЛ 2: Работа с базой данных

### Файл 1: `db/database.js`
```javascript
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const dbPath = path.join(__dirname, 'db.json');
const adapter = new FileSync(dbPath);
const database = low(adapter);

function init() {
  database.defaults({ users: {} }).write();
}
```
**Примечание:** `lowdb` использует `FileSync` адаптер, который автоматически сохраняет изменения через `.write()`.

### Файл 2: `db/users.js`
```javascript
// Функция обновления пользователя
function updateUser(userId, updates) {
  const userIdStr = userId.toString();
  const user = db.get('users').get(userIdStr).value();
  
  if (!user) {
    throw new Error(`Пользователь ${userId} не найден`);
  }
  
  // ✅ LOWDB АВТОМАТИЧЕСКИ СОХРАНЯЕТ через .write()
  db.get('users').get(userIdStr).assign(updates).write();
  return getUser(userId);
}
```

### ⚠️ ВОЗМОЖНАЯ ПРОБЛЕМА:
В `endGame()` используется **прямое чтение/запись через `fs.writeFileSync`** (строка 594), а затем **обновление через `updateUser()`** (строка 606). Это может создать рассинхронизацию:
1. `fs.writeFileSync` пишет напрямую в файл
2. `updateUser()` использует `lowdb`, который может перезаписать файл старыми данными из памяти

**Рекомендация:** Использовать ТОЛЬКО `updateUser()` или ТОЛЬКО `fs.writeFileSync`, но не оба одновременно.

---

## 🔍 УЗЕЛ 3: Обработка платежей (после "✅ НАЙДЕНО СОВПАДЕНИЕ")

**Файл:** `payment/tonPayment.js` (строки 333-411)

### Код обработки платежа:

```javascript
// После "✅ НАЙДЕНО СОВПАДЕНИЕ" (строка 335)
console.log(`✅ НАЙДЕНО СОВПАДЕНИЕ: [${comment}] для пользователя [${foundPayment.userId}]`);

// Проверка суммы...
// ...

// ✅ ОБРАБОТКА ПЛАТЕЖА (строка 364)
try {
  const user = await getUser(foundPayment.userId);
  const newBalance = user.games_balance + foundPayment.games;
  
  // ✅ ОБНОВЛЕНИЕ БАЛАНСА ЧЕРЕЗ updateUser (lowdb)
  await updateUser(foundPayment.userId, {
    games_balance: newBalance
  });
  
  // ✅ УДАЛЕНИЕ ИЗ PENDING
  delete pendingPayments[foundPaymentId];
  
  // ✅ ДОБАВЛЕНИЕ В PROCESSED
  processedTx[txHash] = {
    userId: foundPayment.userId,
    comment,
    amount: expectedAmountTon,
    games: foundPayment.games,
    processedAt: Date.now()
  };
  
  // ✅ СОХРАНЕНИЕ ФАЙЛОВ (async fs.promises)
  await fs.writeFile(PENDING_PAYMENTS_FILE, JSON.stringify(pendingPayments, null, 2));
  await fs.writeFile(PROCESSED_TX_FILE, JSON.stringify(processedTx, null, 2));
  
  console.log(`✅ Платеж обработан:`);
  console.log(`   баланс до: ${user.games_balance}`);
  console.log(`   баланс после: ${newBalance}`);
  
  // ✅ ОТПРАВКА СОБЫТИЯ КЛИЕНТУ
  if (io) {
    const userRoom = `user_${foundPayment.userId}`;
    io.to(userRoom).emit('payment_success', {
      paymentId: foundPaymentId,
      games: foundPayment.games,
      new_balance: newBalance  // ⚠️ ТОЛЬКО games_balance, НЕТ winnings_usdt
    });
  }
} catch (error) {
  console.error(`❌ Ошибка обработки платежа:`, error);
}
```

### ⚠️ ВОЗМОЖНАЯ ПРОБЛЕМА:
- `updateUser()` сохраняет через `lowdb.write()` (синхронно)
- Затем `fs.writeFile()` пишет в другие файлы (асинхронно)
- Если `updateUser()` не завершится до следующего чтения, баланс может быть не сохранен

### ✅ Проверки:
- [x] `updateUser()` вызывается для обновления `games_balance`
- [x] `fs.writeFile()` сохраняет `pending_payments.json` и `processed_tx.json`
- [x] Событие `payment_success` отправляется клиенту

---

## 🔍 УЗЕЛ 4: Синхронизация с фронтендом

### Серверные события (Socket.io emit):

#### 1. После победы (`server.js`, строки 613-619):
```javascript
io.to(`user_${winnerId}`).emit('balance_updated', {
  games_balance: updatedUser.games_balance,
  winnings_usdt: updatedUser.winnings_usdt
});

io.to(`user_${winnerId}`).emit('updateBalance', winAmount);
```

#### 2. После платежа (`tonPayment.js`, строки 401-405):
```javascript
io.to(userRoom).emit('payment_success', {
  paymentId: foundPaymentId,
  games: foundPayment.games,
  new_balance: newBalance  // ⚠️ Только games_balance
});
```

### Клиентские обработчики (`public/app.js`):

#### 1. Обработчик `balance_updated` (строки 274-277):
```javascript
socket.on('balance_updated', (data) => {
  console.log('💰 Баланс обновлен:', data);
  updateBalance(data.games_balance, data.winnings_usdt);
});
```

#### 2. Обработчик `payment_success` (строки 289-310):
```javascript
socket.on('payment_success', (data) => {
  console.log('✅ Payment successful:', data);
  
  // ⚠️ ПРОБЛЕМА: updateBalance вызывается только с games_balance
  updateBalance(data.new_balance, null);  // winnings_usdt = null!
  
  // ...
});
```

#### 3. Функция `updateBalance` (строки 836-842):
```javascript
function updateBalance(gamesBalance, winningsUsdt) {
  const gamesEl = document.getElementById('games-balance');
  const winningsEl = document.getElementById('winnings-balance');
  
  if (gamesEl) gamesEl.textContent = gamesBalance || 0;
  if (winningsEl) winningsEl.textContent = `${(winningsUsdt || 0).toFixed(2)} USDT`;
}
```

#### 4. ⚠️ КРИТИЧЕСКАЯ ПРОБЛЕМА в `endGame()` на клиенте (строка 1350):
```javascript
// Update balances
updateBalance();  // ❌ ВЫЗЫВАЕТСЯ БЕЗ ПАРАМЕТРОВ!
```

### ⚠️ НАЙДЕННЫЕ ПРОБЛЕМЫ:

1. **В `endGame()` на клиенте (строка 1350):**
   - `updateBalance()` вызывается **без параметров**
   - Это приведет к тому, что `gamesBalance` и `winningsUsdt` будут `undefined`
   - UI покажет `0` для обоих балансов

2. **В обработчике `payment_success` (строка 293):**
   - `updateBalance(data.new_balance, null)` - второй параметр `null`
   - `winnings_usdt` всегда будет `0.00 USDT` после платежа
   - Нужно получать `winnings_usdt` из `data` или делать запрос к серверу

3. **В обработчике `payment_success` на сервере:**
   - Событие не включает `winnings_usdt`
   - Клиент не может обновить баланс выигрышей

---

## 🔧 РЕКОМЕНДУЕМЫЕ ИСПРАВЛЕНИЯ:

### Исправление 1: `endGame()` на клиенте
```javascript
// Вместо:
updateBalance();

// Должно быть:
// Нужно получить актуальные данные из data или запросить у сервера
// Или убрать этот вызов, так как баланс обновляется через socket.on('balance_updated')
```

### Исправление 2: Обработчик `payment_success` на сервере
```javascript
// В tonPayment.js, после updateUser:
const updatedUser = getUser(foundPayment.userId);  // Получаем обновленного пользователя

io.to(userRoom).emit('payment_success', {
  paymentId: foundPaymentId,
  games: foundPayment.games,
  new_balance: newBalance,
  winnings_usdt: updatedUser.winnings_usdt  // ✅ Добавить winnings_usdt
});
```

### Исправление 3: Обработчик `payment_success` на клиенте
```javascript
socket.on('payment_success', (data) => {
  console.log('✅ Payment successful:', data);
  
  // ✅ Использовать winnings_usdt из data (если есть)
  updateBalance(data.new_balance, data.winnings_usdt || null);
  
  // ...
});
```

### Исправление 4: Убрать дублирование fs.writeFileSync в `endGame()`
```javascript
// В endGame() - убрать прямой fs.writeFileSync после updateUser()
// Использовать ТОЛЬКО updateUser(), так как lowdb автоматически сохраняет через .write()

// УДАЛИТЬ:
// fs.writeFileSync(dbPath, JSON.stringify(dbDataToSave, null, 2), 'utf8');

// ОСТАВИТЬ ТОЛЬКО:
updateUser(winnerId, {
  winnings_usdt: newWinnings,
  totalEarned: newTotalEarned
});
```

---

## 📋 ЧЕКЛИСТ ДЛЯ ПРОВЕРКИ:

- [ ] `fs.writeFileSync` вызывается в `endGame()` после обновления баланса
- [ ] `winnerId` приводится к строке перед поиском в `users.json`
- [ ] `prize` устанавливается в `1.5` и отправляется в `game_end`
- [ ] События `balance_updated` отправляются клиенту с `games_balance` и `winnings_usdt`
- [ ] На клиенте `updateBalance()` вызывается с правильными параметрами
- [ ] В `payment_success` отправляется `winnings_usdt` (если доступен)
- [ ] Нет дублирования сохранения (fs.writeFileSync И updateUser одновременно)

