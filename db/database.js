/**
 * Инициализация базы данных lowdb
 */

const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');

const dbPath = path.join(__dirname, 'db.json');
const adapter = new FileSync(dbPath);
const database = low(adapter);

// Инициализация схемы БД
function init() {
  database.defaults({
    users: {}
  }).write();
  
  return Promise.resolve();
}

module.exports = {
  init,
  db: database
};


