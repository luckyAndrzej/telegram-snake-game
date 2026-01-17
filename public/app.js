/**
 * Telegram Mini App - Frontend
 * Мультиплеерная игра "Змейка"
 */

// Telegram Web App API
const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();

// Глобальные переменные
let socket = null;
let userId = null;
let username = null;
let gameState = 'loading'; // loading, menu, waiting, countdown, playing, result
let currentGame = null;
let gameCanvas = null;
let gameCtx = null;
let debugMode = false;

// Инициализация
document.addEventListener('DOMContentLoaded', () => {
  initSocket();
  initEventListeners();
  initCanvas();
  showScreen('menu');
});

/**
 * Инициализация WebSocket подключения
 */
function initSocket() {
  // Получаем данные пользователя из Telegram
  const user = tg.initDataUnsafe?.user;
  userId = user?.id;
  username = user?.username || `User_${userId}`;
  
  if (!userId) {
    console.error('User ID not found');
    tg.showAlert('Ошибка: не удалось определить пользователя');
    return;
  }
  
  // Подключаемся к Socket.io серверу
  const serverUrl = window.location.origin;
  socket = io(serverUrl, {
    auth: {
      user_id: userId,
      username: username
    }
  });
  
  // Socket.io события
  socket.on('connect', () => {
    console.log('✅ WebSocket подключен');
  });
  
  socket.on('user_data', (data) => {
    debugMode = data.debug_mode;
    updateBalance(data.games_balance, data.winnings_usdt);
    
    // Показываем TEST MODE badge если DEBUG_MODE активен
    const badge = document.getElementById('test-mode-badge');
    if (badge) {
      badge.style.display = debugMode ? 'block' : 'none';
    }
    
    // Показываем кнопку пополнения баланса только в DEBUG_MODE
    const addGamesBtn = document.getElementById('add-games-btn');
    if (addGamesBtn) {
      addGamesBtn.style.display = debugMode ? 'block' : 'none';
    }
  });
  
  socket.on('waiting_opponent', () => {
    showScreen('waiting');
  });
  
  socket.on('game_created', (data) => {
    console.log('Игра создана:', data);
    // Автоматически отправляем сигнал готовности после создания игры
    if (socket && socket.connected) {
      socket.emit('ready');
    }
  });
  
  socket.on('game_start', (data) => {
    console.log('Игра началась:', data);
    startCountdown(() => {
      startGame(data);
    });
  });
  
  socket.on('game_state', (data) => {
    if (currentGame && gameState === 'playing') {
      updateGameState(data);
    }
  });
  
  socket.on('game_end', (data) => {
    endGame(data);
  });
  
  socket.on('error', (error) => {
    console.error('Socket error:', error);
    tg.showAlert(error.message || 'Произошла ошибка');
  });
  
  socket.on('ready_confirmed', () => {
    console.log('Готовность подтверждена');
  });
}

/**
 * Инициализация обработчиков событий
 */
function initEventListeners() {
  // Кнопка "Найти игру"
  document.getElementById('start-game-btn')?.addEventListener('click', () => {
    if (socket && socket.connected) {
      socket.emit('find_match');
    }
  });
  
  // Кнопка "Пополнить баланс" (DEBUG_MODE)
  document.getElementById('add-games-btn')?.addEventListener('click', () => {
    if (debugMode) {
      // В DEBUG_MODE просто вызываем API для пополнения баланса
      addGamesBalance(10); // Добавляем 10 игр
    }
  });
  
  // Игровые кнопки управления
  ['up', 'down', 'left', 'right'].forEach(direction => {
    document.getElementById(`btn-${direction}`)?.addEventListener('click', () => {
      sendDirection(direction);
    });
  });
  
  // Клавиатурное управление
  document.addEventListener('keydown', (e) => {
    if (gameState !== 'playing') return;
    
    const keyMap = {
      'ArrowUp': 'up',
      'ArrowDown': 'down',
      'ArrowLeft': 'left',
      'ArrowRight': 'right'
    };
    
    if (keyMap[e.key]) {
      e.preventDefault();
      sendDirection(keyMap[e.key]);
    }
  });
  
  // Свайпы для управления
  let touchStartX = 0, touchStartY = 0;
  const canvas = document.getElementById('game-canvas');
  
  canvas?.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    e.preventDefault();
  }, { passive: false });
  
  canvas?.addEventListener('touchend', (e) => {
    if (!touchStartX || !touchStartY) return;
    
    const touchEndX = e.changedTouches[0].clientX;
    const touchEndY = e.changedTouches[0].clientY;
    const diffX = touchStartX - touchEndX;
    const diffY = touchStartY - touchEndY;
    
    if (Math.abs(diffX) > Math.abs(diffY)) {
      sendDirection(diffX > 0 ? 'left' : 'right');
    } else {
      sendDirection(diffY > 0 ? 'up' : 'down');
    }
    
    touchStartX = 0;
    touchStartY = 0;
    e.preventDefault();
  }, { passive: false });
  
  // Кнопки результатов
  document.getElementById('play-again-btn')?.addEventListener('click', () => {
    if (socket && socket.connected) {
      socket.emit('find_match');
    }
  });
  
  document.getElementById('menu-btn')?.addEventListener('click', () => {
    showScreen('menu');
  });
}

/**
 * Инициализация canvas
 */
function initCanvas() {
  gameCanvas = document.getElementById('game-canvas');
  if (!gameCanvas) return;
  
  gameCtx = gameCanvas.getContext('2d');
  
  // Устанавливаем размер canvas
  const container = gameCanvas.parentElement;
  const size = Math.min(container.clientWidth - 20, 600);
  gameCanvas.width = size;
  gameCanvas.height = size;
}

/**
 * Отправка команды направления
 */
function sendDirection(direction) {
  if (socket && socket.connected && gameState === 'playing') {
    socket.emit('direction', direction);
  }
}

/**
 * Показ экрана
 */
function showScreen(screenName) {
  document.querySelectorAll('.screen').forEach(screen => {
    screen.classList.remove('active');
  });
  
  const screen = document.getElementById(`${screenName}-screen`);
  if (screen) {
    screen.classList.add('active');
    gameState = screenName;
  }
}

/**
 * Обновление баланса
 */
function updateBalance(gamesBalance, winningsUsdt) {
  const gamesEl = document.getElementById('games-balance');
  const winningsEl = document.getElementById('winnings-balance');
  
  if (gamesEl) gamesEl.textContent = gamesBalance || 0;
  if (winningsEl) winningsEl.textContent = `${(winningsUsdt || 0).toFixed(2)} USDT`;
}

/**
 * Пополнение баланса (DEBUG_MODE)
 */
async function addGamesBalance(amount) {
  try {
    const response = await fetch(`/api/add-games/${userId}?amount=${amount}`);
    const data = await response.json();
    
    if (data.success) {
      updateBalance(data.games_balance, data.winnings_usdt);
      tg.showAlert(`✅ Баланс пополнен на ${amount} игр`);
    } else {
      tg.showAlert(`❌ Ошибка: ${data.error}`);
    }
  } catch (error) {
    console.error('Ошибка пополнения баланса:', error);
    tg.showAlert('Ошибка при пополнении баланса');
  }
}

/**
 * Countdown перед началом игры
 */
function startCountdown(callback) {
  showScreen('countdown');
  let count = 3;
  const countdownEl = document.getElementById('countdown-number');
  
  const interval = setInterval(() => {
    if (countdownEl) {
      countdownEl.textContent = count;
    }
    
    count--;
    
    if (count < 0) {
      clearInterval(interval);
      callback();
    }
  }, 1000);
}

/**
 * Начало игры
 */
function startGame(data) {
  showScreen('playing');
  currentGame = {
    gameId: data.gameId,
    startTime: data.start_time
  };
  
  // Отправляем сигнал готовности
  if (socket && socket.connected) {
    socket.emit('ready');
  }
}

/**
 * Обновление состояния игры
 */
function updateGameState(data) {
  if (!gameCanvas || !gameCtx || !data.my_snake || !data.opponent_snake) return;
  
  // Очищаем canvas
  gameCtx.clearRect(0, 0, gameCanvas.width, gameCanvas.height);
  
  // Рисуем сетку
  drawGrid();
  
  // Рисуем змейки
  drawSnake(data.my_snake, '#ff4444'); // Красная
  drawSnake(data.opponent_snake, '#4444ff'); // Синяя
  
  // Обновляем статусы игроков
  const player1Status = document.getElementById('player1-status');
  const player2Status = document.getElementById('player2-status');
  
  if (player1Status) player1Status.textContent = `Вы: ${data.my_snake.alive ? 'Живы' : 'Мертвы'}`;
  if (player2Status) player2Status.textContent = `Соперник: ${data.opponent_snake.alive ? 'Живы' : 'Мертвы'}`;
}

/**
 * Рисование сетки
 */
function drawGrid() {
  const tileSize = gameCanvas.width / 20; // 20 клеток по ширине
  const width = gameCanvas.width;
  const height = gameCanvas.height;
  
  gameCtx.strokeStyle = '#333333';
  gameCtx.lineWidth = 1;
  
  for (let i = 0; i <= 20; i++) {
    // Вертикальные линии
    gameCtx.beginPath();
    gameCtx.moveTo(i * tileSize, 0);
    gameCtx.lineTo(i * tileSize, height);
    gameCtx.stroke();
    
    // Горизонтальные линии
    gameCtx.beginPath();
    gameCtx.moveTo(0, i * tileSize);
    gameCtx.lineTo(width, i * tileSize);
    gameCtx.stroke();
  }
}

/**
 * Рисование змейки
 */
function drawSnake(snake, color) {
  if (!snake || !snake.body || snake.body.length === 0) return;
  
  const tileSize = gameCanvas.width / 20;
  
  gameCtx.fillStyle = color;
  
  snake.body.forEach((segment, index) => {
    const x = segment.x * tileSize;
    const y = segment.y * tileSize;
    
    if (index === 0) {
      // Голова - рисуем больше
      gameCtx.fillRect(x + 1, y + 1, tileSize - 2, tileSize - 2);
    } else {
      // Тело
      gameCtx.fillRect(x + 2, y + 2, tileSize - 4, tileSize - 4);
    }
  });
}

/**
 * Завершение игры
 */
function endGame(data) {
  currentGame = null;
  showScreen('result');
  
  const isWinner = data.winnerId === userId;
  const resultIcon = document.getElementById('result-icon');
  const resultTitle = document.getElementById('result-title');
  const resultMessage = document.getElementById('result-message');
  const resultPrize = document.getElementById('result-prize');
  
  if (resultIcon) {
    resultIcon.textContent = isWinner ? '🏆' : '💀';
  }
  
  if (resultTitle) {
    resultTitle.textContent = isWinner ? 'Победа!' : 'Поражение';
  }
  
  if (resultMessage) {
    resultMessage.textContent = isWinner 
      ? `Вы выиграли ${data.prize.toFixed(2)} USDT!` 
      : 'Вы проиграли';
  }
  
  if (resultPrize) {
    resultPrize.textContent = isWinner ? `💰 +${data.prize.toFixed(2)} USDT` : '💰 0 USDT';
  }
  
  // Обновляем балансы
  // TODO: Получить обновленные балансы с сервера
}

