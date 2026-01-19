/**
 * Миграция пользователей из users.json в PostgreSQL
 */

const fs = require('fs').promises;
const path = require('path');
const { User } = require('../models/User');
const { convertToPlainUser } = require('./users');

/**
 * Миграция пользователей из JSON файла в PostgreSQL
 */
async function migrateUsersFromJSON() {
  const jsonPath = path.join(__dirname, 'db.json');
  const backupPath = path.join(__dirname, 'db.json.backup');
  
  try {
    // Проверяем существование файла
    try {
      await fs.access(jsonPath);
    } catch {
      console.log('📋 Файл db.json не найден, миграция не требуется');
      return { migrated: 0, skipped: 0 };
    }
    
    // Читаем JSON файл
    const jsonData = await fs.readFile(jsonPath, 'utf8');
    const data = JSON.parse(jsonData);
    
    if (!data.users || Object.keys(data.users).length === 0) {
      console.log('📋 Файл db.json пуст, миграция не требуется');
      return { migrated: 0, skipped: 0 };
    }
    
    console.log(`📋 Найдено ${Object.keys(data.users).length} пользователей для миграции...`);
    
    let migrated = 0;
    let skipped = 0;
    let errors = 0;
    
    // Мигрируем каждого пользователя
    for (const [userIdStr, userData] of Object.entries(data.users)) {
      try {
        // Проверяем, существует ли пользователь в PostgreSQL
        const existingUser = await User.findByPk(userIdStr);
        
        if (existingUser) {
          console.log(`⏭ Пользователь ${userIdStr} уже существует в PostgreSQL, пропускаем`);
          skipped++;
          continue;
        }
        
        // Создаем пользователя в PostgreSQL
        const [user, created] = await User.findOrCreate({
          where: { userId: userIdStr },
          defaults: {
            userId: userIdStr,
            username: userData.username || `User_${userIdStr}`,
            balanceGames: userData.games_balance || 0,
            winningsTon: userData.winnings_ton || 0,
            walletAddress: userData.wallet || userData.walletAddress || '',
            totalEarned: userData.totalEarned || 0,
            isTester: userData.is_tester || false
          }
        });
        
        if (created) {
          console.log(`✅ Мигрирован пользователь ${userIdStr}: ${userData.username || 'без имени'}`);
          migrated++;
        } else {
          skipped++;
        }
      } catch (error) {
        console.error(`❌ Ошибка миграции пользователя ${userIdStr}:`, error.message);
        errors++;
      }
    }
    
    console.log(`\n📊 Миграция завершена:`);
    console.log(`   ✅ Мигрировано: ${migrated}`);
    console.log(`   ⏭ Пропущено (уже существуют): ${skipped}`);
    if (errors > 0) {
      console.log(`   ❌ Ошибок: ${errors}`);
    }
    
    // Переименовываем файл в backup
    try {
      await fs.rename(jsonPath, backupPath);
      console.log(`\n✅ Файл db.json переименован в db.json.backup`);
    } catch (error) {
      console.error(`⚠️ Не удалось переименовать db.json:`, error.message);
    }
    
    return { migrated, skipped, errors };
  } catch (error) {
    console.error('❌ Ошибка при миграции из JSON:', error.message);
    return { migrated: 0, skipped: 0, errors: 1 };
  }
}

module.exports = {
  migrateUsersFromJSON
};

