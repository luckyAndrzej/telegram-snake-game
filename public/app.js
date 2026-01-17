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
let gameState = 'loading'; // loading, menu, lobby, countdown, playing, result
let currentGame = null;
let gameCanvas = null;
let gameCtx = null;
let debugMode = false;
let currentDirection = null; // Current snake direction (updated from game_state)

// Инициализация
document.addEventListener('DOMContentLoaded', () => {
  console.log('🚀 Инициализация приложения...');
  
  // СНАЧАЛА показываем меню, чтобы интерфейс не блокировался
  showScreen('menu');
  
  // Затем инициализируем остальное
  initCanvas();
  initEventListeners();
  
  // Инициализация сокета в try-catch, чтобы ошибки не блокировали интерфейс
  try {
    initSocket();
  } catch (error) {
    console.error('❌ Ошибка инициализации Socket:', error);
    tg.showAlert('Warning: Could not connect to server');
  }
  
  console.log('✅ Приложение инициализировано');
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
    tg.showAlert('Error: Could not identify user');
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
    console.log('Socket ID:', socket.id);
  });
  
  socket.on('disconnect', (reason) => {
    console.warn('⚠️ WebSocket отключен:', reason);
  });
  
  socket.on('connect_error', (error) => {
    console.error('❌ Ошибка подключения WebSocket:', error);
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
  
  // Screen 2: Waiting for opponent (Lobby)
  socket.on('waiting_opponent', () => {
    console.log('⏳ Waiting for opponent...');
    showScreen('lobby');
  });
  
  // Screen 3: Opponent found (Match Found) - immediately switch to game-screen
  socket.on('match_found', (data) => {
    console.log('🎮 Opponent found (client):', data);
    
    // Сохраняем данные игры
    if (!currentGame) {
      currentGame = {};
    }
    currentGame.gameId = data.gameId;
    currentGame.playerNumber = data.playerNumber;
    
      // Сохраняем начальное состояние для отображения во время countdown
      if (data.initial_state) {
        currentGame.initialState = data.initial_state;
        console.log('✅ Initial game state received');
        
        // Инициализируем текущее направление из начального состояния
        if (data.initial_state.my_snake && data.initial_state.my_snake.direction) {
          const dir = data.initial_state.my_snake.direction;
          if (dir.dx === 1 && dir.dy === 0) {
            currentDirection = 'right';
          } else if (dir.dx === -1 && dir.dy === 0) {
            currentDirection = 'left';
          } else if (dir.dx === 0 && dir.dy === 1) {
            currentDirection = 'down';
          } else if (dir.dx === 0 && dir.dy === -1) {
            currentDirection = 'up';
          }
        }
        
        // Сразу переключаемся на игровой экран (но игра еще не началась - ждем countdown)
        gameState = 'countdown'; // Устанавливаем 'countdown' вместо 'playing' до начала игры
        showScreen('game');
      
      // Инициализируем game-canvas с логическим разрешением 800x800 для четкости
      if (!gameCanvas || !gameCtx) {
        gameCanvas = document.getElementById('game-canvas');
        if (gameCanvas) {
          gameCtx = gameCanvas.getContext('2d');
          // Логическое разрешение 800x800 (CSS растянет его)
          gameCanvas.width = 800;
          gameCanvas.height = 800;
        }
      } else {
        // Пересчитываем размер canvas при каждом входе в игру
        gameCanvas.width = 800;
        gameCanvas.height = 800;
      }
      
      // Показываем countdown overlay
      const countdownOverlay = document.getElementById('countdown-overlay');
      if (countdownOverlay) {
        countdownOverlay.style.display = 'flex';
      } else {
        console.warn('countdown-overlay не найден!');
      }
      
      // Рисуем начальное состояние игры на game-canvas (обе змейки видны, но не двигаются)
      if (gameCanvas && gameCtx) {
        renderGamePreviewOnCanvas(data.initial_state, gameCanvas, gameCtx);
      }
    }
  });
  
  // Обновление countdown (сервер отправляет числа: 3, 2, 1) - overlay поверх game-canvas
  socket.on('countdown', (data) => {
    console.log('⏰ Countdown:', data.number);
    const countdownNumber = document.getElementById('countdown-number');
    if (countdownNumber) {
      countdownNumber.textContent = data.number;
    }
    
    // Обновляем game-canvas во время countdown (рисуем начальное состояние)
    if (gameCanvas && gameCtx && currentGame && currentGame.initialState) {
      renderGamePreviewOnCanvas(currentGame.initialState, gameCanvas, gameCtx);
    }
  });
  
  // Экран 4: Игра начинается (после countdown) - скрываем overlay
  socket.on('game_start', (data) => {
    console.log('🎮 Game started (client):', data);
    
    // Сохраняем данные игры
    if (!currentGame) {
      currentGame = {};
    }
    currentGame.gameId = data.gameId;
    currentGame.startTime = data.start_time || Date.now();
    
    // Принудительная установка gameState = 'playing' (игра действительно началась)
    gameState = 'playing';
    console.log('✅ gameState set to:', gameState);
    
    // Сбрасываем текущее направление при старте игры
    currentDirection = null;
    
    // Очищаем старое начальное состояние сразу после скрытия overlay
    currentGame.initialState = null;
    
    // Скрываем countdown overlay
    const countdownOverlay = document.getElementById('countdown-overlay');
    if (countdownOverlay) {
      countdownOverlay.style.display = 'none';
    }
    
    // Вызываем initCanvas(), чтобы убедиться, что размеры холста актуальны перед отрисовкой
    initCanvas();
    
    // Очищаем canvas и готовимся к игре
    if (gameCanvas && gameCtx) {
      gameCtx.clearRect(0, 0, gameCanvas.width, gameCanvas.height);
      gameCtx.fillStyle = '#0a0e27'; // Modern dark blue background
      gameCtx.fillRect(0, 0, gameCanvas.width, gameCanvas.height);
      drawGrid();
    }
    
    // Проверка: если game_state не приходит в течение 1 секунды, выводим предупреждение
    let gameStateReceived = false;
    const timeoutId = setTimeout(() => {
      if (!gameStateReceived) {
        console.error('⚠️ game_state не получен в течение 1 секунды после game_start');
        tg.showAlert('Warning: Game may not start. Check your connection.');
      }
    }, 1000);
    
    // Слушаем первое game_state событие, чтобы сбросить таймаут
    const onGameState = () => {
      gameStateReceived = true;
      clearTimeout(timeoutId);
      socket.off('game_state', onGameState);
    };
    socket.once('game_state', onGameState);
    
    console.log('✅ Игра началась, ожидаем game_state события...');
  });
  
  socket.on('game_state', (data) => {
    // Обновляем состояние игры только если игра активна (после countdown)
    // Проверяем и 'playing' и 'countdown', чтобы не пропустить первые обновления
    if (currentGame && (gameState === 'playing' || gameState === 'countdown')) {
      // Если пришло game_state, значит игра уже началась - переключаем на playing
      if (gameState === 'countdown') {
        gameState = 'playing';
      }
      updateGameState(data);
    } else {
      console.warn('⚠️ game_state received but gameState is:', gameState, 'currentGame:', currentGame);
    }
  });
  
  socket.on('game_end', (data) => {
    console.log('📨 Событие game_end получено!', data);
    endGame(data);
  });
  
  socket.on('error', (error) => {
    console.error('Socket error:', error);
    tg.showAlert(error.message || 'An error occurred');
  });
  
  socket.on('ready_confirmed', () => {
    console.log('Готовность подтверждена');
  });
}

/**
 * Инициализация обработчиков событий
 */
function initEventListeners() {
  // "Find Match" button - switch to lobby screen
  document.getElementById('start-game-btn')?.addEventListener('click', () => {
    if (socket && socket.connected) {
      // Switch to lobby screen (waiting)
      showScreen('lobby');
      // Отправляем запрос на поиск соперника
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
  
  // "Withdraw Funds" button
  document.getElementById('withdraw-btn')?.addEventListener('click', () => {
    handleWithdraw();
  });
  
  // Rules toggle (collapsible)
  const rulesToggle = document.getElementById('rules-toggle');
  const rulesContent = document.getElementById('rules-content');
  if (rulesToggle && rulesContent) {
    rulesToggle.addEventListener('click', () => {
      const isHidden = rulesContent.style.display === 'none';
      rulesContent.style.display = isHidden ? 'block' : 'none';
      rulesToggle.classList.toggle('active', isHidden);
    });
  }
  
  // Игровые кнопки управления (моментальный отклик)
  ['up', 'down', 'left', 'right'].forEach(direction => {
    const btn = document.getElementById(`btn-${direction}`);
    if (btn) {
      // Используем 'pointerdown' вместо 'click' для мгновенной реакции (мобильные)
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault(); // Предотвращаем задержки
        sendDirection(direction);
      }, { passive: false });
      // Также добавляем 'click' для совместимости
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        sendDirection(direction);
      }, { passive: false });
    }
  });
  
  // Клавиатурное управление (моментальный отклик)
  document.addEventListener('keydown', (e) => {
    // Разрешаем во время countdown и playing для мгновенной реакции
    if (gameState !== 'playing' && gameState !== 'countdown') return;
    
    const keyMap = {
      'ArrowUp': 'up',
      'ArrowDown': 'down',
      'ArrowLeft': 'left',
      'ArrowRight': 'right'
    };
    
    if (keyMap[e.key]) {
      e.preventDefault();
      sendDirection(keyMap[e.key]); // Моментально отправляем
    }
  }, { passive: false }); // Отключаем пассивный режим для мгновенной реакции
  
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
  // "Play Again" button - find new game
  document.getElementById('play-again-btn')?.addEventListener('click', () => {
    // Удаляем класс active с экрана результатов
    const resultScreen = document.getElementById('result-screen');
    if (resultScreen) {
      resultScreen.classList.remove('active');
    }
    
    // Очищаем состояние игры
    currentGame = null;
    gameState = 'lobby';
    
    // Переключаемся на экран лобби
    showScreen('lobby');
    
    // Вызываем socket.emit('find_match')
    if (socket && socket.connected) {
      socket.emit('find_match');
    }
  });
  
  // "Menu" button - return to main menu (shows first screen on entry)
  document.getElementById('menu-btn')?.addEventListener('click', () => {
    console.log('🔄 Returning to main menu');
    
    // Полная очистка состояния: сбрасываем Socket.io состояние
    currentGame = null;
    gameState = 'menu';
    
    // Переключаемся на главное меню (первое окно при входе в игру)
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
  
  // Устанавливаем логическое разрешение 800x800 (CSS растянет его)
  gameCanvas.width = 800;
  gameCanvas.height = 800;
  
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
  
  // Инициализируем canvas для waiting (если есть)
  // Это будет вызвано позже при показе экрана ожидания
}

/**
 * Инициализация waiting-canvas
 */
function initWaitingCanvas() {
  const waitingCanvas = document.getElementById('waiting-canvas');
  if (waitingCanvas && !window.waitingCanvas) {
    const size = Math.min(waitingCanvas.parentElement.clientWidth - 20, 600);
    waitingCanvas.width = size;
    waitingCanvas.height = size;
    
    window.waitingCanvas = waitingCanvas;
    window.waitingCtx = waitingCanvas.getContext('2d');
    console.log('✅ waiting-canvas инициализирован:', size);
  }
}

/**
 * Отправка команды направления с проверкой на поворот на 180° (моментальный отклик)
 */
function sendDirection(direction) {
  // Моментальная проверка - без задержек
  if (!socket || !socket.connected) return;
  if (gameState !== 'playing' && gameState !== 'countdown') return; // Разрешаем во время countdown
  
  // Карта противоположных направлений (быстрая проверка)
  const opposites = {
    'up': 'down',
    'down': 'up',
    'left': 'right',
    'right': 'left'
  };
  
  // Мгновенная проверка на поворот на 180° (запрещено) - без логирования для скорости
  if (currentDirection && direction === opposites[currentDirection]) {
    return; // Мгновенно прерываем - не отправляем команду
  }
  
  // Моментально отправляем команду на сервер (без задержек)
  socket.emit('direction', direction);
}

/**
 * Показ экрана
 */
function showScreen(screenName) {
  console.log('🖥️ Switching to screen:', screenName);
  
  // Находим все элементы с классом screen и принудительно скрываем их
  const screens = document.querySelectorAll('.screen');
  screens.forEach(s => {
    s.classList.remove('active');
    s.style.display = 'none'; // Принудительное скрытие для исключения просвечивания
  });

  // Ищем целевой экран по id (screenName + '-screen')
  const targetId = `${screenName}-screen`;
  const target = document.getElementById(targetId);
  if (target) {
    // Для экрана результатов используем display: flex, для остальных - CSS класс
    if (screenName === 'result') {
      target.style.display = 'flex';
    } else {
      target.style.display = ''; // Сбрасываем inline display для использования CSS
    }
    target.classList.add('active');
    gameState = screenName;
    console.log(`✅ Screen "${targetId}" shown`);
  } else {
    console.warn(`❌ Screen "${targetId}" not found!`);
  }
}

/**
 * Обработка вывода средств
 */
function handleWithdraw() {
  const winningsEl = document.getElementById('winnings-balance');
  const currentBalance = parseFloat(winningsEl?.textContent?.replace(' USDT', '') || '0');
  
  if (currentBalance <= 0) {
    if (window.Telegram && window.Telegram.WebApp) {
      window.Telegram.WebApp.showAlert('No funds available for withdrawal');
    } else {
      alert('No funds available for withdrawal');
    }
    return;
  }
  
  const withdrawMessage = `Withdraw ${currentBalance.toFixed(2)} USDT?`;
  
  // Показываем подтверждение
  if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.showConfirm) {
    window.Telegram.WebApp.showConfirm(
      withdrawMessage,
      (confirmed) => {
        if (confirmed) {
          // TODO: Реализовать вывод средств (TON blockchain интеграция)
          // В DEBUG_MODE просто показываем сообщение
          const message = debugMode 
            ? `DEBUG: Withdrawal of ${currentBalance.toFixed(2)} USDT would be processed`
            : 'Withdrawal functionality coming soon';
          
          if (window.Telegram && window.Telegram.WebApp) {
            window.Telegram.WebApp.showAlert(message);
          } else {
            alert(message);
          }
        }
      }
    );
  } else {
    // Fallback для случаев, когда showConfirm недоступен
    if (confirm(withdrawMessage)) {
      const message = debugMode 
        ? `DEBUG: Withdrawal of ${currentBalance.toFixed(2)} USDT would be processed`
        : 'Withdrawal functionality coming soon';
      
      if (window.Telegram && window.Telegram.WebApp) {
        window.Telegram.WebApp.showAlert(message);
      } else {
        alert(message);
      }
    }
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
 * Начало игры
 */
function startGame(data) {
  console.log('🎮 Начало игры:', data);
  
  // Обновляем currentGame с данными из data
  if (!currentGame) {
    currentGame = {};
  }
  
  if (data.gameId) {
    currentGame.gameId = data.gameId;
  }
  currentGame.startTime = data.start_time || Date.now();
  
  // Переключаемся на игровой экран (ID в HTML: game-screen)
  console.log('📺 Switching to game screen');
  gameState = 'playing'; // Используем 'playing' для проверки в game_state
  showScreen('game'); // ID экрана в HTML: game-screen
  
  // Инициализируем игровой canvas если нужно
  if (!gameCanvas || !gameCtx) {
    gameCanvas = document.getElementById('game-canvas');
    if (gameCanvas) {
      gameCtx = gameCanvas.getContext('2d');
      // Устанавливаем размер canvas
      const container = gameCanvas.parentElement;
      const size = Math.min(container.clientWidth - 20, 600);
      gameCanvas.width = size;
      gameCanvas.height = size;
    }
  }
  
  if (gameCanvas && gameCtx) {
    // Принудительная очистка canvas
    gameCtx.clearRect(0, 0, gameCanvas.width, gameCanvas.height);
    
    // Очищаем canvas и рисуем начальный фон
    gameCtx.fillStyle = '#0a0e27'; // Modern dark blue background
    gameCtx.fillRect(0, 0, gameCanvas.width, gameCanvas.height);
    drawGrid();
  }
  
  // Игра уже запущена сервером, он отправляет game_state события
  // Ждем первое обновление состояния игры
  console.log('✅ Игра началась, ожидаем game_state события...');
}

/**
 * Обновление состояния игры
 */
function updateGameState(data) {
  console.log('Drawing state...'); // Лог для проверки прихода данных
  console.log('Данные игры:', data); // Логирование для отладки
  
  if (!gameCanvas || !gameCtx) {
    console.warn('Canvas не инициализирован!');
    return;
  }
  
  if (!data || !data.my_snake || !data.opponent_snake) {
    console.warn('Неполные данные игры:', data);
    return;
  }
  
  // Проверка координат змеек для отладки
  if (data.my_snake && data.my_snake.body && data.my_snake.body.length > 0) {
    console.log('Snake pos:', data.my_snake.body[0]);
  }
  
  // Очищаем canvas
  gameCtx.clearRect(0, 0, gameCanvas.width, gameCanvas.height);
  
  // Фон для игрового поля
  gameCtx.fillStyle = '#0a0e27'; // Modern dark blue background
  gameCtx.fillRect(0, 0, gameCanvas.width, gameCanvas.height);
  
  // Рисуем сетку
  drawGrid();
  
  // Рисуем змейки с современным дизайном
  drawSnake(data.my_snake, '#ff4444', '#ff6666'); // Красная с градиентом
  drawSnake(data.opponent_snake, '#4444ff', '#6666ff'); // Синяя с градиентом
  
  // Обновляем текущее направление только после реального хода (когда змейка уже переместилась)
  if (data.my_snake && data.my_snake.direction) {
    // Конвертируем объект направления {dx, dy} в строку 'up'/'down'/'left'/'right'
    const dir = data.my_snake.direction;
    if (dir.dx === 1 && dir.dy === 0) {
      currentDirection = 'right';
    } else if (dir.dx === -1 && dir.dy === 0) {
      currentDirection = 'left';
    } else if (dir.dx === 0 && dir.dy === 1) {
      currentDirection = 'down';
    } else if (dir.dx === 0 && dir.dy === -1) {
      currentDirection = 'up';
    }
  }
  
  // Обновляем статусы игроков
  const player1Status = document.getElementById('player1-status');
  const player2Status = document.getElementById('player2-status');
  
  if (player1Status) player1Status.textContent = `You: ${data.my_snake.alive ? 'Alive' : 'Dead'}`;
  if (player2Status) player2Status.textContent = `Opponent: ${data.opponent_snake.alive ? 'Alive' : 'Dead'}`;
}

/**
 * Рисование сетки (современный дизайн)
 */
function drawGrid() {
  const tileSize = gameCanvas.width / 30; // 30 клеток по ширине (обновлено для большего поля)
  const width = gameCanvas.width;
  const height = gameCanvas.height;
  
  // Более яркие линии сетки для лучшей видимости
  gameCtx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
  gameCtx.lineWidth = 0.5;
  
  for (let i = 0; i <= 30; i++) { // Updated for 30x30 field
    // Vertical lines
    gameCtx.beginPath();
    gameCtx.moveTo(i * tileSize, 0);
    gameCtx.lineTo(i * tileSize, height);
    gameCtx.stroke();
    
    // Horizontal lines
    gameCtx.beginPath();
    gameCtx.moveTo(0, i * tileSize);
    gameCtx.lineTo(width, i * tileSize);
    gameCtx.stroke();
  }
}

/**
 * Рисование змейки (современный дизайн с градиентами, neon эффектом и глазами по направлению)
 */
function drawSnake(snake, color1, color2) {
  if (!snake || !snake.body || snake.body.length === 0) return;
  
  const tileSize = gameCanvas.width / 30; // 30 клеток по ширине (обновлено для большего поля)
  
  // Определяем направление змейки для глаз
  let direction = snake.direction;
  
  // Если direction отсутствует, используем жестко заданное направление на основе цвета змейки
  if (!direction) {
    // Красная змейка (игрок 1) смотрит вправо, синяя (игрок 2) - влево
    if (color1 === '#ff4444') {
      // Игрок 1 - красная змейка, смотрит вправо (лицом к сопернику)
      direction = { dx: 1, dy: 0 };
    } else if (color1 === '#4444ff') {
      // Игрок 2 - синяя змейка, смотрит влево (лицом к сопернику)
      direction = { dx: -1, dy: 0 };
    } else if (snake.body.length > 1) {
      // Если цвет не определен, вычисляем из первых двух сегментов
      const head = snake.body[0];
      const next = snake.body[1];
      direction = {
        dx: head.x - next.x,
        dy: head.y - next.y
      };
    } else {
      // По умолчанию вправо
      direction = { dx: 1, dy: 0 };
    }
  }
  
  // Градиент для змейки (переливание от яркого к темному)
  const gradient = gameCtx.createLinearGradient(0, 0, gameCanvas.width, gameCanvas.height);
  gradient.addColorStop(0, color1); // Яркий цвет
  gradient.addColorStop(0.5, color2); // Средний цвет
  gradient.addColorStop(1, color1); // Темный оттенок для объема
  
  snake.body.forEach((segment, index) => {
    const x = segment.x * tileSize;
    const y = segment.y * tileSize;
    const size = tileSize - 2;
    const offset = 1;
    const radius = size * (index === 0 ? 0.2 : 0.15);
    
    // Neon эффект (свечение цвета змейки) - увеличенная интенсивность
    gameCtx.shadowColor = color1;
    gameCtx.shadowBlur = 18; // Увеличено с 8 до 18 для лучшей видимости
    gameCtx.shadowOffsetX = 0;
    gameCtx.shadowOffsetY = 0;
    
    if (index === 0) {
      // Голова - рисуем с градиентом и скруглениями
      gameCtx.fillStyle = gradient;
      gameCtx.beginPath();
      gameCtx.roundRect(x + offset, y + offset, size, size, radius);
      gameCtx.fill();
      
      // Яркая белая обводка головы для лучшей видимости
      gameCtx.strokeStyle = '#ffffff';
      gameCtx.lineWidth = 2;
      gameCtx.beginPath();
      gameCtx.roundRect(x + offset, y + offset, size, size, radius);
      gameCtx.stroke();
      
      // Сбрасываем свечение для глаз
      gameCtx.shadowBlur = 0;
      gameCtx.shadowColor = 'transparent';
      
      // Глаза на голове с учетом направления
      let eyeX1, eyeY1, eyeX2, eyeY2;
      const centerX = x + offset + size / 2;
      const centerY = y + offset + size / 2;
      const eyeOffset = size * 0.2;
      const eyeSize = size * 0.12;
      
      if (direction) {
        // Вычисляем позицию глаз в зависимости от направления
        if (direction.dx > 0) {
          // Движется вправо - глаза справа
          eyeX1 = centerX + eyeOffset * 0.5;
          eyeY1 = centerY - eyeOffset * 0.5;
          eyeX2 = centerX + eyeOffset * 0.5;
          eyeY2 = centerY + eyeOffset * 0.5;
        } else if (direction.dx < 0) {
          // Движется влево - глаза слева
          eyeX1 = centerX - eyeOffset * 0.5;
          eyeY1 = centerY - eyeOffset * 0.5;
          eyeX2 = centerX - eyeOffset * 0.5;
          eyeY2 = centerY + eyeOffset * 0.5;
        } else if (direction.dy > 0) {
          // Движется вниз - глаза внизу
          eyeX1 = centerX - eyeOffset * 0.5;
          eyeY1 = centerY + eyeOffset * 0.5;
          eyeX2 = centerX + eyeOffset * 0.5;
          eyeY2 = centerY + eyeOffset * 0.5;
        } else {
          // Движется вверх - глаза вверху (по умолчанию)
          eyeX1 = centerX - eyeOffset * 0.5;
          eyeY1 = centerY - eyeOffset * 0.5;
          eyeX2 = centerX + eyeOffset * 0.5;
          eyeY2 = centerY - eyeOffset * 0.5;
        }
      } else {
        // По умолчанию глаза вверху
        eyeX1 = centerX - eyeOffset * 0.5;
        eyeY1 = centerY - eyeOffset * 0.5;
        eyeX2 = centerX + eyeOffset * 0.5;
        eyeY2 = centerY - eyeOffset * 0.5;
      }
      
      // Рисуем глаза (белые круги с небольшим свечением)
      gameCtx.shadowColor = 'rgba(255, 255, 255, 0.5)';
      gameCtx.shadowBlur = 3;
      gameCtx.fillStyle = '#ffffff';
      gameCtx.beginPath();
      gameCtx.arc(eyeX1, eyeY1, eyeSize, 0, Math.PI * 2);
      gameCtx.fill();
      gameCtx.beginPath();
      gameCtx.arc(eyeX2, eyeY2, eyeSize, 0, Math.PI * 2);
      gameCtx.fill();
    } else {
      // Тело - закругленные сегменты с neon эффектом
      gameCtx.fillStyle = gradient;
      gameCtx.beginPath();
      gameCtx.roundRect(x + offset + 1, y + offset + 1, size - 2, size - 2, radius);
      gameCtx.fill();
    }
    
    // Сбрасываем свечение для следующего сегмента
    gameCtx.shadowBlur = 0;
    gameCtx.shadowColor = 'transparent';
  });
}

/**
 * Отображение preview игры на указанном canvas
 */
function renderGamePreviewOnCanvas(gameState, canvas, ctx) {
  if (!canvas || !ctx || !gameState) {
    console.error('❌ renderGamePreviewOnCanvas: canvas, ctx или gameState отсутствуют');
    return;
  }
  
  console.log('🎨 renderGamePreviewOnCanvas: canvas size:', canvas.width, 'x', canvas.height);
  
  // Очищаем canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  // СНАЧАЛА рисуем фон (темный)
  ctx.fillStyle = '#0a0e27'; // Modern dark blue background
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  
  // Затем рисуем сетку (более яркую для лучшей видимости)
  const tileSize = canvas.width / 30; // 30 клеток по ширине (обновлено для большего поля)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
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
    
    // Определяем направление змейки для глаз (лицом друг к другу)
    let direction = snake.direction;
    if (!direction) {
      // Красная змейка смотрит вправо, синяя - влево
      if (color1 === '#ff4444') {
        direction = { dx: 1, dy: 0 }; // Вправо
      } else if (color1 === '#4444ff') {
        direction = { dx: -1, dy: 0 }; // Влево
      }
    }
    
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, color1);
    gradient.addColorStop(1, color2);
    
    snake.body.forEach((segment, index) => {
      const x = segment.x * tileSize;
      const y = segment.y * tileSize;
      const size = tileSize - 2;
      
      // Neon эффект (свечение цвета змейки) - увеличенная интенсивность для видимости
      ctx.shadowColor = color1;
      ctx.shadowBlur = 18; // Увеличено для лучшей видимости
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
      
      if (index === 0) {
        // Голова
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.roundRect(x + 1, y + 1, size, size, size * 0.2);
        ctx.fill();
        
        // Яркая белая обводка головы для лучшей видимости
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(x + 1, y + 1, size, size, size * 0.2);
        ctx.stroke();
        
        // Глаза на голове с учетом направления (лицом друг к другу)
        ctx.shadowBlur = 0;
        ctx.shadowColor = 'transparent';
        ctx.fillStyle = '#ffffff';
        
        let eyeX1, eyeY1, eyeX2, eyeY2;
        const centerX = x + 1 + size / 2;
        const centerY = y + 1 + size / 2;
        const eyeOffset = size * 0.2;
        const eyeSize = size * 0.1;
        
        if (direction) {
          // Вычисляем позицию глаз в зависимости от направления
          if (direction.dx > 0) {
            // Движется вправо - глаза справа
            eyeX1 = centerX + eyeOffset * 0.5;
            eyeY1 = centerY - eyeOffset * 0.5;
            eyeX2 = centerX + eyeOffset * 0.5;
            eyeY2 = centerY + eyeOffset * 0.5;
          } else if (direction.dx < 0) {
            // Движется влево - глаза слева
            eyeX1 = centerX - eyeOffset * 0.5;
            eyeY1 = centerY - eyeOffset * 0.5;
            eyeX2 = centerX - eyeOffset * 0.5;
            eyeY2 = centerY + eyeOffset * 0.5;
          } else if (direction.dy > 0) {
            // Движется вниз - глаза внизу
            eyeX1 = centerX - eyeOffset * 0.5;
            eyeY1 = centerY + eyeOffset * 0.5;
            eyeX2 = centerX + eyeOffset * 0.5;
            eyeY2 = centerY + eyeOffset * 0.5;
          } else {
            // Движется вверх - глаза вверху
            eyeX1 = centerX - eyeOffset * 0.5;
            eyeY1 = centerY - eyeOffset * 0.5;
            eyeX2 = centerX + eyeOffset * 0.5;
            eyeY2 = centerY - eyeOffset * 0.5;
          }
        } else {
          // По умолчанию глаза вверху
          eyeX1 = centerX - eyeOffset * 0.5;
          eyeY1 = centerY - eyeOffset * 0.5;
          eyeX2 = centerX + eyeOffset * 0.5;
          eyeY2 = centerY - eyeOffset * 0.5;
        }
        
        ctx.beginPath();
        ctx.arc(eyeX1, eyeY1, eyeSize, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(eyeX2, eyeY2, eyeSize, 0, Math.PI * 2);
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
  
  // Draw snakes with modern design
  drawSnakePreview(gameState.my_snake, '#ff4444', '#ff6666', 'You (🔴)');
  drawSnakePreview(gameState.opponent_snake, '#4444ff', '#6666ff', 'Opponent (🔵)');
}

/**
 * Завершение игры
 */
function endGame(data) {
  console.log('🎯 endGame called, data:', data);
  console.log('Attempting to show results screen...');
  
  // Принудительная остановка игрового состояния
  gameState = 'result';
  currentGame = null; // This will stop updates via game_state
  
  // Check for data from game_end event, use default values
  // If data is empty, function should still work
  const isWinner = data && data.winnerId ? data.winnerId === userId : false;
  const prize = data && data.prize ? data.prize : 0;
  
  const resultIcon = document.getElementById('result-icon');
  const resultTitle = document.getElementById('result-title');
  const resultMessage = document.getElementById('result-message');
  const resultPrize = document.getElementById('result-prize');
  
  // Update all elements BEFORE showing screen
  if (resultIcon) {
    resultIcon.textContent = isWinner ? '🏆' : '💀';
  }
  
  // Clear text: "VICTORY!" (green) or "DEFEAT" (red)
  // If no data, use default text: "Connection lost" or "Match ended"
  if (resultTitle) {
    if (data && data.winnerId) {
      resultTitle.textContent = isWinner ? 'VICTORY!' : 'DEFEAT';
      resultTitle.style.color = isWinner ? '#10b981' : '#ef4444';
    } else {
      resultTitle.textContent = 'Match Ended';
      resultTitle.style.color = '#666';
    }
  }
  
  if (resultMessage) {
    if (data && data.winnerId) {
      resultMessage.textContent = isWinner 
        ? `You won ${prize.toFixed(2)} USDT!` 
        : 'You lost';
    } else {
      // If connection lost or data didn't arrive
      resultMessage.textContent = data ? 'Connection lost' : 'Match ended';
    }
  }
  
  if (resultPrize) {
    resultPrize.textContent = isWinner ? `💰 +${prize.toFixed(2)} USDT` : '💰 0 USDT';
  }
  
  // Update balances
  updateBalance();
  
  // FORCE show results screen
  const resultScreen = document.getElementById('result-screen');
  if (!resultScreen) {
    console.error('❌ Element #result-screen not found in DOM!');
    return;
  }
  
  // Hide ALL screens
  document.querySelectorAll('.screen').forEach(s => {
    s.classList.remove('active');
    s.style.display = 'none';
  });
  
  // Show results screen
  resultScreen.classList.add('active');
  resultScreen.style.display = 'flex';
  resultScreen.style.zIndex = '9999';
  
  console.log('✅ Results screen shown. Check:', {
    display: resultScreen.style.display,
    classList: resultScreen.classList.toString(),
    zIndex: resultScreen.style.zIndex
  });
}

