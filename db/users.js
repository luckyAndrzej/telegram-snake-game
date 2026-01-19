/**
 * Работа с пользователями в PostgreSQL (Sequelize)
 */

const { User, sequelize } = require('../models/User');

/**
 * Инициализация нового пользователя
 */
async function initUser(userId, username, debugMode) {
  const userIdStr = userId.toString();
  
  try {
    const initialBalance = debugMode ? 100 : 0; // DEBUG_MODE: 100 бесплатных игр
    
    const [user, created] = await User.findOrCreate({
      where: { userId: userIdStr },
      defaults: {
        userId: userIdStr,
        username: username || `User_${userId}`,
        balanceGames: initialBalance,
        winningsTon: 0,
        walletAddress: '',
        totalEarned: 0,
        isTester: debugMode
      }
    });
    
    if (created) {
      console.log(`✅ Новый пользователь создан в PostgreSQL: ${userId} (баланс: ${initialBalance} игр)`);
    }
    
    return convertToPlainUser(user);
  } catch (error) {
    console.error(`❌ Ошибка создания/получения пользователя ${userId}:`, error.message);
    throw error;
  }
}

/**
 * Получить пользователя
 */
async function getUser(userId) {
  const userIdStr = userId.toString();
  
  try {
    const user = await User.findByPk(userIdStr);
    
    if (!user) {
      throw new Error(`Пользователь ${userId} не найден`);
    }
    
    return convertToPlainUser(user);
  } catch (error) {
    console.error(`❌ Ошибка получения пользователя ${userId}:`, error.message);
    throw error;
  }
}

/**
 * Обновить пользователя
 */
async function updateUser(userId, updates) {
  const userIdStr = userId.toString();
  
  try {
    const user = await User.findByPk(userIdStr);
    
    if (!user) {
      throw new Error(`Пользователь ${userId} не найден`);
    }
    
    // Преобразуем имена полей из camelCase в snake_case
    const dbUpdates = {};
    if (updates.games_balance !== undefined) dbUpdates.balanceGames = updates.games_balance;
    if (updates.winnings_ton !== undefined) dbUpdates.winningsTon = updates.winnings_ton;
    if (updates.totalEarned !== undefined) dbUpdates.totalEarned = updates.totalEarned;
    if (updates.wallet !== undefined || updates.walletAddress !== undefined) {
      dbUpdates.walletAddress = updates.wallet || updates.walletAddress || '';
    }
    if (updates.is_tester !== undefined) dbUpdates.isTester = updates.is_tester;
    if (updates.username !== undefined) dbUpdates.username = updates.username;
    
    await user.update(dbUpdates);
    
    // Возвращаем обновленного пользователя
    return convertToPlainUser(user);
  } catch (error) {
    console.error(`❌ Ошибка обновления пользователя ${userId}:`, error.message);
    throw error;
  }
}

/**
 * Пополнить баланс игр (для DEBUG_MODE)
 */
async function addGames(userId, amount) {
  const userIdStr = userId.toString();
  
  try {
    const user = await User.findByPk(userIdStr);
    
    if (!user) {
      throw new Error(`Пользователь ${userId} не найден`);
    }
    
    await user.increment('balanceGames', { by: amount });
    
    // Возвращаем обновленного пользователя
    const updatedUser = await User.findByPk(userIdStr);
    return convertToPlainUser(updatedUser);
  } catch (error) {
    console.error(`❌ Ошибка пополнения баланса игрока ${userId}:`, error.message);
    throw error;
  }
}

/**
 * Покупка игр с выигрышного баланса (Реинвест)
 */
async function buyGamesWithWinnings(userId, amount = 1) {
  const userIdStr = userId.toString();
  
  // Используем транзакцию для гарантии безопасности
  const transaction = await sequelize.transaction();
  
  try {
    const user = await User.findByPk(userIdStr, { transaction });
    
    if (!user) {
      await transaction.rollback();
      throw new Error(`Пользователь ${userId} не найден`);
    }
    
    // Проверяем баланс выигрышей
    if (!user.winningsTon || user.winningsTon < amount) {
      await transaction.rollback();
      return {
        success: false,
        error: 'Недостаточно выигрышей'
      };
    }
    
    // Уменьшаем winnings_ton на amount и увеличиваем balance_games на amount
    await user.decrement('winningsTon', { by: amount, transaction });
    await user.increment('balanceGames', { by: amount, transaction });
    
    // Подтверждаем транзакцию
    await transaction.commit();
    
    // Возвращаем обновленного пользователя
    const updatedUser = await User.findByPk(userIdStr);
    
    console.log(`✅ Игрок ${userId} купил ${amount} игр за ${amount} TON выигрышей. Новый баланс: ${updatedUser.balanceGames} игр, выигрышей: ${updatedUser.winningsTon} TON`);
    
    return {
      success: true,
      user: convertToPlainUser(updatedUser),
      gamesPurchased: amount
    };
  } catch (error) {
    await transaction.rollback();
    console.error(`❌ Ошибка покупки игр за выигрыши для игрока ${userId}:`, error.message);
    return {
      success: false,
      error: error.message || 'Ошибка при покупке игр'
    };
  }
}

/**
 * Конвертировать модель Sequelize в обычный объект (для совместимости)
 */
function convertToPlainUser(user) {
  if (!user) return null;
  
  // Если это уже plain object, возвращаем как есть
  if (!user.toJSON) {
    return user;
  }
  
  const plain = user.toJSON();
  
  // Преобразуем имена полей обратно в формат, используемый в коде
  return {
    tg_id: parseInt(plain.userId) || plain.userId,
    userId: plain.userId,
    username: plain.username || `User_${plain.userId}`,
    wallet: plain.walletAddress || '',
    walletAddress: plain.walletAddress || '',
    games_balance: plain.balanceGames || 0,
    balanceGames: plain.balanceGames || 0,
    winnings_ton: plain.winningsTon || 0,
    winningsTon: plain.winningsTon || 0,
    totalEarned: plain.totalEarned || 0,
    is_tester: plain.isTester || false,
    isTester: plain.isTester || false,
    created_at: plain.createdAt ? new Date(plain.createdAt).getTime() : Date.now(),
    updated_at: plain.updatedAt ? new Date(plain.updatedAt).getTime() : Date.now()
  };
}

module.exports = {
  initUser,
  getUser,
  updateUser,
  addGames,
  buyGamesWithWinnings,
  convertToPlainUser
};
