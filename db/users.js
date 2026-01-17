/**
 * Работа с пользователями в базе данных
 */

const { db } = require('./database');

/**
 * Инициализация нового пользователя
 */
async function initUser(userId, username, debugMode) {
  const userIdStr = userId.toString();
  const existingUser = db.get('users').get(userIdStr).value();
  
  if (!existingUser) {
    // Новый пользователь
    const initialBalance = debugMode ? 100 : 0; // DEBUG_MODE: 100 бесплатных игр
    
    db.get('users').set(userIdStr, {
      tg_id: userId,
      username: username || `User_${userId}`,
      wallet: '',
      games_balance: initialBalance,
      winnings_usdt: 0,
      is_tester: debugMode,
      created_at: Date.now()
    }).write();
    
    console.log(`✅ Новый пользователь создан: ${userId} (баланс: ${initialBalance} игр)`);
  }
  
  return getUser(userId);
}

/**
 * Получить пользователя
 */
function getUser(userId) {
  const userIdStr = userId.toString();
  const user = db.get('users').get(userIdStr).value();
  
  if (!user) {
    throw new Error(`Пользователь ${userId} не найден`);
  }
  
  return user;
}

/**
 * Обновить пользователя
 */
function updateUser(userId, updates) {
  const userIdStr = userId.toString();
  const user = db.get('users').get(userIdStr).value();
  
  if (!user) {
    throw new Error(`Пользователь ${userId} не найден`);
  }
  
  db.get('users').get(userIdStr).assign(updates).write();
  return getUser(userId);
}

/**
 * Пополнить баланс игр (для DEBUG_MODE)
 */
function addGames(userId, amount) {
  const user = getUser(userId);
  return updateUser(userId, {
    games_balance: user.games_balance + amount
  });
}

module.exports = {
  initUser,
  getUser,
  updateUser,
  addGames
};

