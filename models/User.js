/**
 * Модель пользователя для PostgreSQL (Sequelize)
 */

const { Sequelize, DataTypes } = require('sequelize');

// Получаем DATABASE_URL из переменных окружения
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL не задана в переменных окружения!');
  console.warn('⚠️ PostgreSQL подключение не будет работать без DATABASE_URL');
}

// Инициализация Sequelize
// DATABASE_URL имеет формат: postgres://user:password@host:port/database
// Sequelize автоматически парсит этот URL
const sequelize = DATABASE_URL
  ? new Sequelize(DATABASE_URL, {
      dialect: 'postgres',
      dialectOptions: {
        ssl: {
          require: true,
          rejectUnauthorized: false // Обязательно для Railway PostgreSQL
        }
      },
      logging: process.env.NODE_ENV === 'development' ? console.log : false
    })
  : null;

/**
 * Модель пользователя
 */
const User = sequelize ? sequelize.define('User', {
  userId: {
    type: DataTypes.STRING,
    primaryKey: true,
    unique: true,
    allowNull: false,
    field: 'user_id' // Название колонки в БД
  },
  username: {
    type: DataTypes.STRING,
    allowNull: true,
    field: 'username'
  },
  balanceGames: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    allowNull: false,
    field: 'balance_games'
  },
  winningsTon: {
    type: DataTypes.FLOAT,
    defaultValue: 0.0,
    allowNull: false,
    field: 'winnings_ton'
  },
  walletAddress: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: '',
    field: 'wallet_address'
  },
  totalEarned: {
    type: DataTypes.FLOAT,
    defaultValue: 0.0,
    allowNull: false,
    field: 'total_earned'
  },
  isTester: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    allowNull: false,
    field: 'is_tester'
  },
  createdAt: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
    field: 'created_at'
  },
  updatedAt: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
    field: 'updated_at'
  }
}, {
  tableName: 'users',
  timestamps: true,
  underscored: true,
  freezeTableName: true
}) : null;

/**
 * Функция для инициализации подключения к БД
 */
async function initializeDatabase() {
  if (!sequelize) {
    console.warn('⚠️ Sequelize не инициализирован (DATABASE_URL не задана)');
    return false;
  }

  try {
    await sequelize.authenticate();
    console.log('✅ PostgreSQL подключение установлено успешно');
    
    // Синхронизация модели с БД (создание таблицы, если её нет)
    // В production лучше использовать миграции
    await sequelize.sync({ alter: false }); // alter: false - не изменяет существующую структуру
    console.log('✅ Модель User синхронизирована с БД');
    
    return true;
  } catch (error) {
    console.error('❌ Ошибка подключения к PostgreSQL:', error.message);
    return false;
  }
}

/**
 * Функция для закрытия подключения
 */
async function closeConnection() {
  if (sequelize) {
    await sequelize.close();
    console.log('✅ PostgreSQL подключение закрыто');
  }
}

module.exports = {
  User,
  sequelize,
  initializeDatabase,
  closeConnection
};

