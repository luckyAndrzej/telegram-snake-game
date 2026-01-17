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
    // Сохраняем начальное состояние для отображения во время countdown
    if (data.initial_state) {
      currentGame = {
        gameId: data.gameId,
        startTime: data.start_time,
        initialState: data.initial_state
      };
    }
    startCountdown(() => {
      startGame(data);
    });
  });
  
  socket.on('game_state', (data) => {
    console.log('Получено game_state:', data, 'gameState:', gameState);
    // Обновляем состояние игры если игра активна или если мы только начали
    if (currentGame && (gameState === 'playing' || gameState === 'countdown')) {
      // Если мы еще на countdown, но получили game_state - значит игра уже началась
      if (gameState === 'countdown') {
        // Переходим в playing режим
        gameState = 'playing';
        showScreen('playing');
      }
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
  // Добавляем поддержку roundRect для старых браузеров
  if (!CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function(x, y, width, height, radius) {
      this.beginPath();
      this.moveTo(x + radius, y);
      this.lineTo(x + width - radius, y);
      this.quadraticCurveTo(x + width, y, x + width, y + radius);
      this.lineTo(x + width, y + height - radius);
      this.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
      this.lineTo(x + radius, y + height);
      this.quadraticCurveTo(x, y + height, x, y + height - radius);
      this.lineTo(x, y + radius);
      this.quadraticCurveTo(x, y, x + radius, y);
      this.closePath();
    };
  }
  
  gameCanvas = document.getElementById('game-canvas');
  if (!gameCanvas) return;
  
  gameCtx = gameCanvas.getContext('2d');
  
  // Устанавливаем размер canvas
  const container = gameCanvas.parentElement;
  const size = Math.min(container.clientWidth - 20, 600);
  gameCanvas.width = size;
  gameCanvas.height = size;
  
  // Инициализируем canvas для countdown (если есть)
  const countdownCanvas = document.getElementById('countdown-canvas');
  if (countdownCanvas) {
    const countdownCtx = countdownCanvas.getContext('2d');
    countdownCanvas.width = size;
    countdownCanvas.height = size;
    
    // Временно используем countdown canvas для отрисовки во время countdown
    window.countdownCanvas = countdownCanvas;
    window.countdownCtx = countdownCtx;
  }
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
  
  // Инициализируем countdown canvas если еще не инициализирован
  const countdownCanvasEl = document.getElementById('countdown-canvas');
  if (countdownCanvasEl && !window.countdownCanvas) {
    window.countdownCanvas = countdownCanvasEl;
    window.countdownCtx = countdownCanvasEl.getContext('2d');
    const size = Math.min(countdownCanvasEl.parentElement.clientWidth - 20, 600);
    countdownCanvasEl.width = size;
    countdownCanvasEl.height = size;
  }
  
  // Если есть начальное состояние игры - показываем его во время countdown
  if (currentGame && currentGame.initialState) {
    renderGamePreview(currentGame.initialState);
  }
  
  let count = 3;
  const countdownEl = document.getElementById('countdown-number');
  
  const interval = setInterval(() => {
    if (countdownEl) {
      countdownEl.textContent = count;
    }
    
    // Обновляем preview во время countdown
    if (currentGame && currentGame.initialState) {
      renderGamePreview(currentGame.initialState);
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
  console.log('Начало игры:', data);
  showScreen('playing');
  
  // Обновляем currentGame с данными из data
  if (data.gameId) {
    currentGame = {
      gameId: data.gameId,
      startTime: data.start_time || Date.now()
    };
  } else if (currentGame) {
    // Если gameId уже есть в currentGame (из game_start), сохраняем его
    currentGame.startTime = data.start_time || Date.now();
  }
  
  // Игра уже запущена сервером, он отправляет game_state события
  // Ждем первое обновление состояния игры
  console.log('Игра началась, ожидаем game_state события...');
}

/**
 * Обновление состояния игры
 */
function updateGameState(data) {
  if (!gameCanvas || !gameCtx || !data.my_snake || !data.opponent_snake) return;
  
  // Очищаем canvas
  gameCtx.clearRect(0, 0, gameCanvas.width, gameCanvas.height);
  
  // Фон для игрового поля
  gameCtx.fillStyle = '#1a1a2e';
  gameCtx.fillRect(0, 0, gameCanvas.width, gameCanvas.height);
  
  // Рисуем сетку
  drawGrid();
  
  // Рисуем змейки с современным дизайном
  drawSnake(data.my_snake, '#ff4444', '#ff6666'); // Красная с градиентом
  drawSnake(data.opponent_snake, '#4444ff', '#6666ff'); // Синяя с градиентом
  
  // Обновляем статусы игроков
  const player1Status = document.getElementById('player1-status');
  const player2Status = document.getElementById('player2-status');
  
  if (player1Status) player1Status.textContent = `Вы: ${data.my_snake.alive ? 'Живы' : 'Мертвы'}`;
  if (player2Status) player2Status.textContent = `Соперник: ${data.opponent_snake.alive ? 'Живы' : 'Мертвы'}`;
}

/**
 * Рисование сетки (современный дизайн)
 */
function drawGrid() {
  const tileSize = gameCanvas.width / 20; // 20 клеток по ширине
  const width = gameCanvas.width;
  const height = gameCanvas.height;
  
  // Более тонкие и прозрачные линии сетки
  gameCtx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
  gameCtx.lineWidth = 0.5;
  
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
 * Рисование змейки (современный дизайн с градиентами и тенями)
 */
function drawSnake(snake, color1, color2) {
  if (!snake || !snake.body || snake.body.length === 0) return;
  
  const tileSize = gameCanvas.width / 20;
  
  // Градиент для змейки
  const gradient = gameCtx.createLinearGradient(0, 0, gameCanvas.width, gameCanvas.height);
  gradient.addColorStop(0, color1);
  gradient.addColorStop(1, color2);
  
  snake.body.forEach((segment, index) => {
    const x = segment.x * tileSize;
    const y = segment.y * tileSize;
    const size = tileSize - 2;
    const offset = 1;
    
    // Тень для сегмента
    gameCtx.shadowColor = 'rgba(0, 0, 0, 0.3)';
    gameCtx.shadowBlur = 4;
    gameCtx.shadowOffsetX = 2;
    gameCtx.shadowOffsetY = 2;
    
    if (index === 0) {
      // Голова - рисуем с градиентом и больше
      gameCtx.fillStyle = gradient;
      gameCtx.beginPath();
      gameCtx.roundRect(x + offset, y + offset, size, size, size * 0.2);
      gameCtx.fill();
      
      // Глаза на голове
      gameCtx.shadowBlur = 0;
      gameCtx.fillStyle = '#ffffff';
      gameCtx.beginPath();
      gameCtx.arc(x + size * 0.3, y + size * 0.3, size * 0.1, 0, Math.PI * 2);
      gameCtx.fill();
      gameCtx.beginPath();
      gameCtx.arc(x + size * 0.7, y + size * 0.3, size * 0.1, 0, Math.PI * 2);
      gameCtx.fill();
    } else {
      // Тело - закругленные сегменты
      gameCtx.fillStyle = gradient;
      gameCtx.beginPath();
      gameCtx.roundRect(x + offset + 1, y + offset + 1, size - 2, size - 2, size * 0.15);
      gameCtx.fill();
    }
    
    gameCtx.shadowBlur = 0;
    gameCtx.shadowOffsetX = 0;
    gameCtx.shadowOffsetY = 0;
  });
}

/**
 * Отображение preview игры во время countdown
 */
function renderGamePreview(gameState) {
  // Используем countdown canvas если доступен, иначе основной canvas
  const canvas = window.countdownCanvas || gameCanvas;
  const ctx = window.countdownCtx || gameCtx;
  
  if (!canvas || !ctx || !gameState) return;
  
  // Очищаем canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  // Рисуем сетку
  const tileSize = canvas.width / 20;
  ctx.strokeStyle = '#333333';
  ctx.lineWidth = 1;
  
  for (let i = 0; i <= 20; i++) {
    // Вертикальные линии
    ctx.beginPath();
    ctx.moveTo(i * tileSize, 0);
    ctx.lineTo(i * tileSize, canvas.height);
    ctx.stroke();
    
    // Горизонтальные линии
    ctx.beginPath();
    ctx.moveTo(0, i * tileSize);
    ctx.lineTo(canvas.width, i * tileSize);
    ctx.stroke();
  }
  
  // Фон для countdown canvas
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  
  // Рисуем сетку для countdown (прозрачную)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.lineWidth = 0.5;
  
  for (let i = 0; i <= 20; i++) {
    // Вертикальные линии
    ctx.beginPath();
    ctx.moveTo(i * tileSize, 0);
    ctx.lineTo(i * tileSize, canvas.height);
    ctx.stroke();
    
    // Горизонтальные линии
    ctx.beginPath();
    ctx.moveTo(0, i * tileSize);
    ctx.lineTo(canvas.width, i * tileSize);
    ctx.stroke();
  }
  
  // Функция для рисования красивой змейки
  const drawSnakePreview = (snake, color1, color2, label) => {
    if (!snake || !snake.body) return;
    
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, color1);
    gradient.addColorStop(1, color2);
    
    snake.body.forEach((segment, index) => {
      const x = segment.x * tileSize;
      const y = segment.y * tileSize;
      const size = tileSize - 2;
      
      // Тень
      ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
      ctx.shadowBlur = 4;
      ctx.shadowOffsetX = 2;
      ctx.shadowOffsetY = 2;
      
      if (index === 0) {
        // Голова
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.roundRect(x + 1, y + 1, size, size, size * 0.2);
        ctx.fill();
        
        // Глаза на голове
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(x + size * 0.3, y + size * 0.3, size * 0.1, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x + size * 0.7, y + size * 0.3, size * 0.1, 0, Math.PI * 2);
        ctx.fill();
        
        // Подпись
        ctx.shadowBlur = 6;
        ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 12px Arial';
        ctx.fillText(label, x - 30, y - 5);
      } else {
        // Тело
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.roundRect(x + 2, y + 2, size - 2, size - 2, size * 0.15);
        ctx.fill();
      }
      
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
    });
  };
  
  // Рисуем змейки с современным дизайном
  drawSnakePreview(gameState.my_snake, '#ff4444', '#ff6666', 'Вы (🔴)');
  drawSnakePreview(gameState.opponent_snake, '#4444ff', '#6666ff', 'Соперник (🔵)');
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

