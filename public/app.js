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
let canvasLogicalSize = 800; // Логический размер canvas (без DPR) для корректной отрисовки

// Константа задержки интерполяции (ровно один тик сервера)
const INTERPOLATION_OFFSET = 111.11; // мс

// Состояние игры для интерполяции (чистая интерполяция без предсказания)
let gameStateData = null;
let previousGameStateData = null; // Предыдущее состояние для интерполяции
let lastGameStateUpdate = 0;
let animationFrameId = null;

// Input Buffer: очередь команд для предотвращения потери быстрых нажатий
let inputBuffer = [];
let lastDirectionSentTime = 0;
const INPUT_BUFFER_DELAY = 0; // Немедленная отправка для мгновенного отклика

// Jitter Buffer: задержка рендеринга для стабилизации интерполяции
const RENDER_DELAY = 0; // Убрано для мгновенного отклика

// Offscreen canvas для сетки (оптимизация отрисовки)
let gridCanvas = null;
let gridCtx = null;

/**
 * Универсальная функция для открытия/закрытия модальных окон
 */
function toggleModal(modalId, show) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  
  if (show) {
    // Очистка инлайновых стилей перед показом
    modal.style.display = '';
    modal.style.opacity = '';
    modal.style.transform = '';
    
    modal.classList.add('modal-visible');
    // Отключаем game-controls при открытом модальном окне
    const gameControls = document.querySelector('.game-controls');
    if (gameControls) {
      gameControls.style.pointerEvents = 'none';
      gameControls.style.opacity = '0.5';
    }
  } else {
    modal.classList.remove('modal-visible');
    // Очистка инлайновых стилей после скрытия
    modal.style.display = '';
    modal.style.opacity = '';
    modal.style.transform = '';
    
    // Включаем game-controls обратно при закрытии модального окна
    const gameControls = document.querySelector('.game-controls');
    if (gameControls) {
      gameControls.style.pointerEvents = 'auto';
      gameControls.style.opacity = '1';
    }
  }
}

// Инициализация
document.addEventListener('DOMContentLoaded', () => {
  console.log('🚀 Инициализация приложения...');
  
  // Принудительная очистка стилей модальных окон при загрузке
  document.querySelectorAll('.payment-modal').forEach(m => {
    m.classList.remove('modal-visible');
    m.style.display = ''; // Очистка инлайновых стилей
    m.style.opacity = '';
    m.style.transform = '';
  });
  
  // Явно скрываем все модальные окна при загрузке
  toggleModal('withdrawal-modal', false);
  toggleModal('payment-modal', false);
  
  // СНАЧАЛА показываем меню, чтобы интерфейс не блокировался
  showScreen('menu');
  
  // Затем инициализируем остальное
  initCanvas();
  initEventListeners();
  
  // Добавляем обработчик изменения размера окна для адаптивности canvas
  let resizeTimeout;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      // Пересчитываем размер canvas при изменении размера окна с учетом DPR
      if (gameCanvas && gameCtx) {
        const dpr = window.devicePixelRatio || 1;
        const containerWidth = gameCanvas.parentElement?.clientWidth || window.innerWidth;
        const containerHeight = window.innerHeight * 0.5;
        const maxCanvasSize = Math.min(containerWidth - 40, containerHeight, 800);
        
        // Сохраняем логический размер
        canvasLogicalSize = maxCanvasSize;
        
        // Устанавливаем физический размер с учетом DPR (для четкости на Retina)
        const logicalWidth = maxCanvasSize * dpr;
        const logicalHeight = maxCanvasSize * dpr;
        
        gameCanvas.width = logicalWidth;
        gameCanvas.height = logicalHeight;
        
        // Масштабируем контекст (сбрасываем трансформацию перед scale для избежания накопления)
        gameCtx.setTransform(1, 0, 0, 1, 0, 0);
        gameCtx.scale(dpr, dpr);
        
        // CSS размер для отображения (без DPR)
        gameCanvas.style.width = maxCanvasSize + 'px';
        gameCanvas.style.height = maxCanvasSize + 'px';
        
        // Отключаем сглаживание для производительности пиксельной графики
        gameCtx.imageSmoothingEnabled = false;
        
        // Пересоздаем offscreen canvas для сетки при изменении размера
        if (gridCanvas) {
          gridCanvas.width = canvasLogicalSize;
          gridCanvas.height = canvasLogicalSize;
          drawGridToOffscreen();
        }
        
        // Если игра активна, перерисовываем состояние
        if (gameState === 'playing' && currentGame && gameStateData) {
          // Быстрая перерисовка текущего состояния
          requestAnimationFrame(() => {
            if (gameCtx && gameStateData) {
              gameCtx.clearRect(0, 0, maxCanvasSize, maxCanvasSize);
              gameCtx.fillStyle = '#0a0e27';
              gameCtx.fillRect(0, 0, maxCanvasSize, maxCanvasSize);
              // Используем offscreen canvas для сетки
              if (gridCanvas) {
                gameCtx.drawImage(gridCanvas, 0, 0);
              } else {
                drawGrid();
              }
              drawSnake(gameStateData.my_snake, '#ff4444', '#ff6666');
              drawSnake(gameStateData.opponent_snake, '#4444ff', '#6666ff');
            }
          });
        }
      }
    }, 100); // Debounce для производительности
  });
  
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
    },
    // Оптимизация для минимальной задержки
    transports: ['websocket'],
    upgrade: false,
    rememberUpgrade: true
  });
  
  // Socket.io события
  socket.on('connect', () => {
    console.log('✅ WebSocket подключен');
    console.log('Socket ID:', socket.id);
    // Запускаем измерение пинга
    startPingMeasurement();
  });
  
  socket.on('disconnect', (reason) => {
    console.warn('⚠️ WebSocket отключен:', reason);
    // Останавливаем измерение пинга
    stopPingMeasurement();
  });
  
  // Обработчик для ping/pong для измерения задержки
  socket.on('pong', (timestamp) => {
    const ping = Date.now() - timestamp;
    updatePingDisplay(ping);
  });
  
  socket.on('connect_error', (error) => {
    console.error('❌ Ошибка подключения WebSocket:', error);
  });
  
  socket.on('user_data', (data) => {
    debugMode = data.debug_mode;
    updateBalance(data.games_balance, data.winnings_ton);
    
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
    
    // Показываем кнопки покупки игр только в НЕ DEBUG_MODE
    const buyGamesSection = document.getElementById('buy-games-section');
    if (buyGamesSection) {
      buyGamesSection.style.display = !debugMode ? 'block' : 'none';
    }
  });
  
  // Screen 2: Waiting for opponent (Lobby)
  socket.on('waiting_opponent', () => {
    console.log('⏳ Waiting for opponent...');
    showScreen('lobby');
  });
  
  // Отмена поиска
  socket.on('search_cancelled', () => {
    console.log('✅ Search cancelled');
    showScreen('menu');
    currentGame = null;
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
          // Отключаем сглаживание изображений для четкости
          gameCtx.imageSmoothingEnabled = false;
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
  
  // Обновление countdown (сервер отправляет числа: 5, 4, 3, 2, 1) - overlay поверх game-canvas
  socket.on('countdown', (data) => {
    console.log('⏰ Countdown:', data.number);
    const countdownNumber = document.getElementById('countdown-number');
    if (countdownNumber) {
      // Сбрасываем и устанавливаем новое значение (предотвращает наложение цифр)
      countdownNumber.textContent = '';
      // Используем requestAnimationFrame для плавного обновления
      requestAnimationFrame(() => {
        countdownNumber.textContent = data.number;
      });
    }
    
    // Обновляем game-canvas во время countdown (рисуем начальное состояние)
    if (gameCanvas && gameCtx && currentGame && currentGame.initialState) {
      renderGamePreviewOnCanvas(currentGame.initialState, gameCanvas, gameCtx);
    }
  });
  
  // Экран 4: Игра начинается (после countdown) - скрываем overlay
  socket.on('game_start', (data) => {
    console.log('🎮 Game started (client):', data);
    
    // Сбрасываем переменную таймера при новом старте игры
    const countdownNumber = document.getElementById('countdown-number');
    if (countdownNumber) {
      countdownNumber.textContent = ''; // Очищаем таймер
    }
    
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
    
    // ИСПРАВЛЕНИЕ: Сбрасываем состояние интерполяции для новой игры
    // Это предотвращает использование данных из предыдущей игры
    previousGameStateData = null;
    gameStateData = null;
    lastGameStateUpdate = 0;
    
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
    // Логирование для диагностики
    console.log('Данные игры получены:', data);
    
    // Обновляем состояние игры только если игра активна (после countdown)
    // Проверяем и 'playing' и 'countdown', чтобы не пропустить первые обновления
    if (currentGame && (gameState === 'playing' || gameState === 'countdown')) {
      // Если пришло game_state, значит игра уже началась - переключаем на playing
      if (gameState === 'countdown') {
        gameState = 'playing';
        
        // Принудительно очищаем все overlay при первом game_state (первый кадр)
        const countdownOverlay = document.getElementById('countdown-overlay');
        if (countdownOverlay) {
          countdownOverlay.style.display = 'none';
        }
        console.log('✅ Overlay очищен при первом game_state');
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
  
  // Обновление баланса после начисления выигрыша
  socket.on('balance_updated', (data) => {
    console.log('💰 Баланс обновлен:', data);
    updateBalance(data.games_balance, data.winnings_ton);
  });
  
  socket.on('error', (error) => {
    console.error('Socket error:', error);
    tg.showAlert(error.message || 'An error occurred');
  });
  
  socket.on('ready_confirmed', () => {
    console.log('Готовность подтверждена');
  });
  
  // Payment success notification
  socket.on('payment_success', (data) => {
    console.log('✅ Payment successful:', data);
    
    // Обновляем баланс
    updateBalance(data.new_balance, data.winnings_ton);
    
    // Закрываем модальное окно платежа
    toggleModal('payment-modal', false);
    
    // Очищаем и скрываем статус "Waiting for payment..."
    const statusEl = document.getElementById('payment-status');
    if (statusEl) {
      statusEl.textContent = '';
      statusEl.style.color = '';
    }
    
    // Показываем уведомление в Telegram
    tg.showAlert(`✅ Payment successful! +${data.games} games added. New balance: ${data.new_balance} games.`);
  });
  
  // Withdrawal success notification
  socket.on('withdrawal_success', (data) => {
    console.log('✅ Withdrawal successful:', data);
    
    // Восстанавливаем кнопку вывода
    const withdrawBtn = document.getElementById('withdraw-btn');
    if (withdrawBtn) {
      withdrawBtn.disabled = false;
      withdrawBtn.innerHTML = withdrawBtn.dataset.originalText || '<span>💸 Withdraw Funds</span>';
      withdrawBtn.style.opacity = '1';
      withdrawBtn.style.cursor = 'pointer';
    }
    
    // Обновляем баланс
    updateBalance(data.games_balance, data.winnings_ton);
    
    // Показываем уведомление
    const message = data.txHash 
      ? `✅ Деньги отправлены! ${data.amount} TON отправлено на ваш кошелек. TX: ${data.txHash.substring(0, 10)}...`
      : `✅ Деньги отправлены! ${data.amount} TON отправлено на ваш кошелек.`;
      
    if (window.Telegram && window.Telegram.WebApp) {
      window.Telegram.WebApp.showAlert(message);
    } else {
      alert(message);
    }
  });
  
  // Withdrawal error notification
  socket.on('withdrawal_error', (error) => {
    console.error('❌ Withdrawal error:', error);
    
    // Восстанавливаем кнопку вывода
    const withdrawBtn = document.getElementById('withdraw-btn');
    if (withdrawBtn) {
      withdrawBtn.disabled = false;
      withdrawBtn.innerHTML = withdrawBtn.dataset.originalText || '<span>💸 Withdraw Funds</span>';
      withdrawBtn.style.opacity = '1';
      withdrawBtn.style.cursor = 'pointer';
    }
    
    // Показываем ошибку
    const errorMessage = error.message || 'Неизвестная ошибка';
    const message = `❌ Ошибка: ${errorMessage}. Проверьте кошелек или баланс.`;
    
    if (window.Telegram && window.Telegram.WebApp) {
      window.Telegram.WebApp.showAlert(message);
    } else {
      alert(message);
    }
  });
  
  // Обработчик успешной покупки игр с выигрышного баланса
  socket.on('buy_games_success', (data) => {
    console.log('✅ Игры куплены за выигрыши:', data);
    
    // Обновляем баланс на экране без перезагрузки
    updateBalance(data.games_balance, data.winnings_ton);
    
    // Восстанавливаем кнопку: разблокируем и возвращаем оригинальный текст (текст цены)
    const buyBtn = document.getElementById('buy-games-with-winnings-btn');
    if (buyBtn) {
      buyBtn.disabled = false;
      buyBtn.classList.remove('processing');
      // Восстанавливаем оригинальный текст из dataset или используем дефолтный
      const originalText = buyBtn.dataset.originalText || '🔄 Buy Games with Winnings (1 TON = 1 Game)';
      buyBtn.innerHTML = originalText;
      buyBtn.style.opacity = '1';
      buyBtn.style.cursor = 'pointer';
      buyBtn.style.transform = '';
    }
    
    tg.showAlert(`✅ Куплено ${data.games_purchased} игр за ${data.games_purchased} TON выигрышей!`);
  });
  
  // Дополнительный обработчик для buy_success (на случай если сервер отправляет это событие)
  socket.on('buy_success', (data) => {
    console.log('✅ Покупка успешна (buy_success):', data);
    
    // Обновляем баланс на экране без перезагрузки
    if (data.games_balance !== undefined && data.winnings_ton !== undefined) {
      updateBalance(data.games_balance, data.winnings_ton);
    }
    
    // Восстанавливаем кнопку: разблокируем и возвращаем оригинальный текст
    const buyBtn = document.getElementById('buy-games-with-winnings-btn');
    if (buyBtn) {
      buyBtn.disabled = false;
      buyBtn.classList.remove('processing');
      const originalText = buyBtn.dataset.originalText || '🔄 Buy Games with Winnings (1 TON = 1 Game)';
      buyBtn.innerHTML = originalText;
      buyBtn.style.opacity = '1';
      buyBtn.style.cursor = 'pointer';
      buyBtn.style.transform = '';
    }
  });
  
  // Обработчик ошибки покупки игр с выигрышного баланса
  socket.on('buy_games_error', (data) => {
    const errorMessage = data.message || 'Ошибка при покупке игр';
    
    // Восстанавливаем кнопку при ошибке: разблокируем и возвращаем оригинальный текст
    const buyBtn = document.getElementById('buy-games-with-winnings-btn');
    if (buyBtn) {
      buyBtn.disabled = false;
      buyBtn.classList.remove('processing');
      buyBtn.innerHTML = buyBtn.dataset.originalText || '<span>🔄 Buy Games with Winnings (1 TON = 1 Game)</span>';
      buyBtn.style.opacity = '1';
      buyBtn.style.cursor = 'pointer';
      buyBtn.style.transform = '';
    }
    
    tg.showAlert(`❌ Ошибка: ${errorMessage}`);
  });
}

/**
 * Инициализация обработчиков событий
 */
/**
 * Создание платежа TON (не DEBUG_MODE)
 */
async function createPayment(packageId) {
  try {
    // Получаем userId из Telegram WebApp
    const userId = tg?.initDataUnsafe?.user?.id;
    if (!userId) {
      tg.showAlert('User ID not found');
      return;
    }

    // Отправляем запрос на создание платежа
    const response = await fetch('/api/create-payment', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        userId,
        packageId
      })
    });

    const data = await response.json();

    if (data.success) {
      console.log('Payment created successfully:', data);
      
      // Проверяем, что все необходимые данные присутствуют
      if (!data.walletAddress || !data.amountTon || !data.comment) {
        console.error('Missing payment data in response:', data);
        tg.showAlert('Payment data is incomplete. Please contact support.');
        return;
      }
      
      // Показываем модальное окно с инструкциями
      const paymentModal = document.getElementById('payment-modal');
      const addressEl = document.getElementById('payment-address');
      const amountTonEl = document.getElementById('payment-amount-ton');
      const commentEl = document.getElementById('payment-comment');
      const statusEl = document.getElementById('payment-status');

      if (paymentModal && addressEl && amountTonEl && commentEl) {
        addressEl.textContent = data.walletAddress;
        // Отображаем сумму только в TON
        amountTonEl.textContent = data.amountTon;
        commentEl.textContent = data.comment;
        
        // Очищаем статус при открытии модального окна
        if (statusEl) {
          statusEl.textContent = '';
          statusEl.style.color = '';
        }

        toggleModal('payment-modal', true);
        
        console.log('Payment modal shown with data:', {
          address: data.walletAddress.substring(0, 10) + '...',
          amountTon: `${data.amountTon} TON`,
          comment: data.comment
        });
      } else {
        console.error('Payment modal elements not found');
        tg.showAlert('Payment modal elements not found. Please reload the page.');
      }
    } else {
      console.error('Payment creation failed:', data);
      tg.showAlert(data.error || 'Failed to create payment');
    }
  } catch (error) {
    console.error('Error creating payment:', error);
    tg.showAlert('Error creating payment. Please try again.');
  }
}

function initEventListeners() {
  // Настройка обработчиков для модального окна вывода
  setupWithdrawalInputHandlers();
  
  // Проверка кнопки вывода в DOM
  const withdrawBtnCheck = document.getElementById('withdraw-btn');
  if (withdrawBtnCheck) {
    console.log('✅ Кнопка вывода найдена в DOM');
  } else {
    console.warn('⚠️ Кнопка вывода (withdraw-btn) не найдена в DOM!');
  }
  
  // "Find Match" button - switch to lobby screen
  document.getElementById('start-game-btn')?.addEventListener('click', () => {
    if (socket && socket.connected) {
      // Switch to lobby screen (waiting)
      showScreen('lobby');
      // Отправляем запрос на поиск соперника
      socket.emit('find_match');
    }
  });
  
  // "Cancel Search" button - cancel search and return to menu
  document.getElementById('cancel-search-btn')?.addEventListener('click', () => {
    if (socket && socket.connected) {
      console.log('❌ Cancelling search...');
      socket.emit('cancel_search');
      // Сразу переключаемся на меню (сервер ответит search_cancelled)
      showScreen('menu');
      currentGame = null;
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
  
  // Buy Games buttons (non-DEBUG_MODE)
  ['buy-1-btn', 'buy-5-btn', 'buy-10-btn'].forEach(btnId => {
    document.getElementById(btnId)?.addEventListener('click', () => {
      const packageId = document.getElementById(btnId).getAttribute('data-package');
      createPayment(packageId);
    });
  });
  
  // Buy Games with Winnings button
  document.getElementById('buy-games-with-winnings-btn')?.addEventListener('click', () => {
    const buyBtn = document.getElementById('buy-games-with-winnings-btn');
    if (buyBtn && !buyBtn.disabled) {
      handleBuyGamesWithWinnings(1); // По умолчанию 1 игра за 1 TON
    }
  });
  
  // Withdrawal modal buttons
  document.getElementById('confirm-withdrawal-btn')?.addEventListener('click', () => {
    confirmWithdrawal();
  });
  
  document.getElementById('close-withdrawal-btn')?.addEventListener('click', () => {
    toggleModal('withdrawal-modal', false);
  });
  
  // Close withdrawal modal when clicking outside
  document.getElementById('withdrawal-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'withdrawal-modal') {
      toggleModal('withdrawal-modal', false);
    }
  });
  
  // Payment modal buttons
  document.getElementById('pay-tonkeeper-btn')?.addEventListener('click', () => {
    const addressEl = document.getElementById('payment-address');
    const amountTonEl = document.getElementById('payment-amount-ton'); // Используем TON для Deep Link
    const commentEl = document.getElementById('payment-comment');
    
    const address = addressEl?.textContent?.trim();
    const amount = amountTonEl?.textContent?.trim(); // Получаем TON из поля
    const comment = commentEl?.textContent?.trim();
    
    console.log('Pay with Tonkeeper clicked:', { address, amount, comment });
    
    if (!address || !amount || !comment) {
      console.error('Missing payment data:', { address: !!address, amount: !!amount, comment: !!comment });
      tg.showAlert('Payment data is missing. Please try again.');
      return;
    }
    
    try {
      // Открываем Tonkeeper через Deep Link
      const nanoTon = (parseFloat(amount) * 1000000000).toString();
      const tonkeeperUrl = `ton://transfer/${address}?amount=${nanoTon}&text=${encodeURIComponent(comment)}`;
      
      console.log('Opening Tonkeeper URL:', tonkeeperUrl);
      
      // В Telegram Mini App для Deep Links ton:// лучше использовать временную ссылку
      // Создаем временный <a> элемент и кликаем по нему
      const link = document.createElement('a');
      link.href = tonkeeperUrl;
      link.style.display = 'none';
      document.body.appendChild(link);
      
      // Пытаемся открыть через клик на ссылке
      try {
        link.click();
        console.log('Clicked Tonkeeper link');
        
        // Удаляем ссылку после клика
        setTimeout(() => {
          document.body.removeChild(link);
        }, 100);
        
        // Обновляем статус
        const statusEl = document.getElementById('payment-status');
        if (statusEl) {
          statusEl.textContent = '⏳ Waiting for payment...';
          statusEl.style.color = '#667eea';
        }
      } catch (linkError) {
        // Если клик не сработал, пробуем tg.openLink()
        console.warn('Link click failed, trying tg.openLink():', linkError);
        document.body.removeChild(link);
        
        if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.openLink) {
          try {
            window.Telegram.WebApp.openLink(tonkeeperUrl, { try_instant_view: false });
            console.log('Opened Tonkeeper via tg.openLink()');
            
            const statusEl = document.getElementById('payment-status');
            if (statusEl) {
              statusEl.textContent = '⏳ Waiting for payment...';
              statusEl.style.color = '#667eea';
            }
          } catch (tgError) {
            // Если tg.openLink() тоже не сработал, пробуем window.location
            console.warn('tg.openLink() failed, trying window.location:', tgError);
            try {
              window.location.href = tonkeeperUrl;
              const statusEl = document.getElementById('payment-status');
              if (statusEl) {
                statusEl.textContent = '⏳ Waiting for payment...';
                statusEl.style.color = '#667eea';
              }
            } catch (locationError) {
              console.error('All methods to open Tonkeeper failed:', locationError);
              const statusEl = document.getElementById('payment-status');
              if (statusEl) {
                statusEl.innerHTML = '⚠️ Please copy the address and comment, then send the payment manually in Tonkeeper app.';
                statusEl.style.color = '#ef4444';
              }
              tg.showAlert('Please open Tonkeeper app manually and send the payment using the address and comment shown above.');
            }
          }
        } else {
          // Fallback: используем window.location
          try {
            window.location.href = tonkeeperUrl;
            const statusEl = document.getElementById('payment-status');
            if (statusEl) {
              statusEl.textContent = '⏳ Waiting for payment...';
              statusEl.style.color = '#667eea';
            }
          } catch (locationError) {
            console.error('Failed to open Tonkeeper:', locationError);
            const statusEl = document.getElementById('payment-status');
            if (statusEl) {
              statusEl.innerHTML = '⚠️ Please copy the address and comment, then send the payment manually in Tonkeeper app.';
              statusEl.style.color = '#ef4444';
            }
          }
        }
      }
    } catch (error) {
      console.error('Error opening Tonkeeper:', error);
      const statusEl = document.getElementById('payment-status');
      if (statusEl) {
        statusEl.innerHTML = '⚠️ Error opening Tonkeeper. Please send the payment manually using the address and comment above.';
        statusEl.style.color = '#ef4444';
      }
    }
  });
  
  document.getElementById('close-payment-btn')?.addEventListener('click', () => {
    toggleModal('payment-modal', false);
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
  
  // Отключаем сглаживание изображений для четкости и устранения микро-размытия при движении
  gameCtx.imageSmoothingEnabled = false;
  
  // Адаптивное логическое разрешение с учетом devicePixelRatio
  // Используем devicePixelRatio для четкости на Retina экранах
  const dpr = window.devicePixelRatio || 1;
  const containerWidth = gameCanvas.parentElement?.clientWidth || window.innerWidth;
  const containerHeight = window.innerHeight * 0.5; // Максимум 50% высоты экрана
  const maxCanvasSize = Math.min(containerWidth - 40, containerHeight, 800); // Ограничиваем 800px
  
  // Сохраняем логический размер для использования в отрисовке
  canvasLogicalSize = maxCanvasSize;
  
  // Устанавливаем физический размер с учетом DPR для четкости
  gameCanvas.width = maxCanvasSize * dpr;
  gameCanvas.height = maxCanvasSize * dpr;
  
  // Масштабируем контекст для корректного отображения (применяем один раз)
  gameCtx.setTransform(1, 0, 0, 1, 0, 0); // Сброс трансформации перед scale
  gameCtx.scale(dpr, dpr);
  
  // CSS размер (для отображения на экране)
  gameCanvas.style.width = maxCanvasSize + 'px';
  gameCanvas.style.height = maxCanvasSize + 'px';
  
  console.log(`🎨 Canvas инициализирован: логический размер=${canvasLogicalSize}px, DPR=${dpr}, физический=${gameCanvas.width}x${gameCanvas.height}`);
  
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
 * Отправка команды направления с Input Buffer и мгновенной визуальной реакцией
 * Input Buffer предотвращает потерю быстрых нажатий из-за задержки сети
 */
function sendDirection(direction) {
  if (!socket || !socket.connected) return;
  if (gameState !== 'playing' && gameState !== 'countdown') return;
  
  // Проверка на поворот на 180° (запрещено)
  const opposites = {
    'up': 'down',
    'down': 'up',
    'left': 'right',
    'right': 'left'
  };
  
  if (currentDirection && direction === opposites[currentDirection]) {
    return; // Запрещаем поворот на 180°
  }
  
  // Обновляем currentDirection для проверки на поворот на 180°
  currentDirection = direction;
  
  // Отправляем команду на сервер
  // Направление обновится только из данных сервера (socket.on('game_state'))
  socket.emit('direction', direction);
  lastDirectionSentTime = performance.now();
}

/**
 * Обработка Input Buffer: отправка команд из очереди на сервер
 */
function processInputBuffer() {
  if (inputBuffer.length === 0) return;
  if (!socket || !socket.connected) {
    inputBuffer = [];
    return;
  }
  
  const now = performance.now();
  
  // Отправляем последнюю команду из буфера (самую актуальную)
  const latestCommand = inputBuffer[inputBuffer.length - 1];
  if (latestCommand) {
    socket.emit('direction', latestCommand.direction);
    lastDirectionSentTime = now;
  }
  
  // Очищаем буфер
  inputBuffer = [];
}

/**
 * Показ экрана
 */
function showScreen(screenName) {
  console.log('🖥️ Switching to screen:', screenName);
  
  // Останавливаем цикл отрисовки если переключаемся с игрового экрана
  if (gameState === 'playing' && screenName !== 'playing') {
    stopRenderLoop();
  }
  
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
 * Валидация TON адреса кошелька
 */
function isValidTonAddress(address) {
  if (!address || typeof address !== 'string') return false;
  const trimmed = address.trim();
  // TON адреса начинаются с EQ или UQ (user-friendly формат)
  return trimmed.length > 20 && (trimmed.startsWith('EQ') || trimmed.startsWith('UQ') || trimmed.startsWith('0Q'));
}

/**
 * Измерение пинга (задержка сети)
 */
let pingInterval = null;

function startPingMeasurement() {
  // Отправляем ping каждые 2 секунды
  pingInterval = setInterval(() => {
    if (socket && socket.connected) {
      socket.emit('ping', Date.now());
    }
  }, 2000);
  
  // Первое измерение сразу
  if (socket && socket.connected) {
    socket.emit('ping', Date.now());
  }
}

function stopPingMeasurement() {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
  updatePingDisplay(null);
}

function updatePingDisplay(ping) {
  const pingValueEl = document.getElementById('ping-value');
  if (pingValueEl) {
    if (ping === null) {
      pingValueEl.textContent = '--';
      pingValueEl.style.color = '#666';
    } else {
      pingValueEl.textContent = ping.toString();
      // Цвет зависит от пинга: зеленый < 50ms, желтый < 100ms, красный > 100ms
      if (ping < 50) {
        pingValueEl.style.color = '#00ff00';
      } else if (ping < 100) {
        pingValueEl.style.color = '#ffff00';
      } else {
        pingValueEl.style.color = '#ff4444';
      }
    }
  }
}

/**
 * Упрощенная обработка полей ввода (только font-size для предотвращения авто-зума)
 */
function setupWithdrawalInputHandlers() {
  const withdrawalInput = document.getElementById('withdrawal-address-input');
  
  if (withdrawalInput) {
    // Устанавливаем font-size: 16px для предотвращения авто-зума на iPhone
    withdrawalInput.style.fontSize = '16px';
    withdrawalInput.style.webkitAppearance = 'none';
    withdrawalInput.style.appearance = 'none';
  }
}

/**
 * Обработка вывода средств
 */
function handleWithdraw() {
  const winningsEl = document.getElementById('winnings-balance');
  const currentBalance = parseFloat(winningsEl?.textContent?.replace(' TON', '') || '0');
  
  if (currentBalance <= 0) {
    if (window.Telegram && window.Telegram.WebApp) {
      window.Telegram.WebApp.showAlert('No funds available for withdrawal');
    } else {
      alert('No funds available for withdrawal');
    }
    return;
  }
  
  // Показываем модальное окно вывода
  const withdrawalModal = document.getElementById('withdrawal-modal');
  const withdrawalAmountDisplay = document.getElementById('withdrawal-amount-display');
  const withdrawalAddressInput = document.getElementById('withdrawal-address-input');
  const withdrawalAddressError = document.getElementById('withdrawal-address-error');
  const withdrawalStatus = document.getElementById('withdrawal-status');
  
  if (!withdrawalModal || !withdrawalAmountDisplay || !withdrawalAddressInput) {
    console.error('Withdrawal modal elements not found');
    return;
  }
  
  // Устанавливаем сумму к выводу (вся доступная сумма)
  withdrawalAmountDisplay.textContent = `${currentBalance.toFixed(2)} TON`;
  
  // Очищаем поле адреса и ошибки
  withdrawalAddressInput.value = '';
  withdrawalAddressError.style.display = 'none';
  withdrawalAddressError.textContent = '';
  withdrawalStatus.textContent = '';
  
  // Используем универсальную функцию toggleModal
  toggleModal('withdrawal-modal', true);
}

/**
 * Подтверждение вывода средств
 */
function confirmWithdrawal() {
  const withdrawBtn = document.getElementById('withdraw-btn');
  const withdrawalModal = document.getElementById('withdrawal-modal');
  const withdrawalAddressInput = document.getElementById('withdrawal-address-input');
  const withdrawalAddressError = document.getElementById('withdrawal-address-error');
  const withdrawalStatus = document.getElementById('withdrawal-status');
  const winningsEl = document.getElementById('winnings-balance');
  
  const userAddress = withdrawalAddressInput?.value?.trim() || '';
  const currentBalance = parseFloat(winningsEl?.textContent?.replace(' TON', '') || '0');
  
  // Валидация адреса
  if (!isValidTonAddress(userAddress)) {
    withdrawalAddressError.textContent = 'Invalid TON wallet address. Must start with EQ or UQ.';
    withdrawalAddressError.style.display = 'block';
    return;
  }
  
  // Скрываем ошибку валидации
  withdrawalAddressError.style.display = 'none';
  
  console.log('📤 Отправляю запрос на вывод через сокет...', { 
    amount: currentBalance, 
    address: userAddress.substring(0, 10) + '...',
    socketConnected: socket?.connected 
  });
  
  // Блокируем кнопки и показываем статус
  if (withdrawBtn) {
    const originalText = withdrawBtn.innerHTML;
    withdrawBtn.disabled = true;
    withdrawBtn.innerHTML = '<span>⏳ Processing...</span>';
    withdrawBtn.style.opacity = '0.6';
    withdrawBtn.style.cursor = 'not-allowed';
    withdrawBtn.dataset.originalText = originalText;
  }
  
  withdrawalStatus.textContent = 'Processing withdrawal request...';
  withdrawalStatus.style.color = '#667eea';
  
  // Отправляем запрос на вывод средств с адресом и всей суммой
  if (socket && socket.connected) {
    socket.emit('requestWithdraw', {
      address: userAddress,
      amount: currentBalance // Вся доступная сумма
    });
    
    // Закрываем модальное окно через небольшую задержку (чтобы пользователь видел статус)
    setTimeout(() => {
      toggleModal('withdrawal-modal', false);
    }, 1000);
  } else {
    // Восстанавливаем кнопку при ошибке
    if (withdrawBtn) {
      withdrawBtn.disabled = false;
      withdrawBtn.innerHTML = withdrawBtn.dataset.originalText || '<span>💸 Withdraw Funds</span>';
      withdrawBtn.style.opacity = '1';
      withdrawBtn.style.cursor = 'pointer';
    }
    
    withdrawalStatus.textContent = 'Error: No connection to server';
    withdrawalStatus.style.color = '#ff4444';
    
    if (window.Telegram && window.Telegram.WebApp) {
      window.Telegram.WebApp.showAlert('Ошибка: нет подключения к серверу');
    } else {
      alert('Ошибка: нет подключения к серверу');
    }
  }
}

/**
 * Покупка игр с выигрышного баланса
 */
function handleBuyGamesWithWinnings(amount = 1) {
  const winningsEl = document.getElementById('winnings-balance');
  const currentWinnings = parseFloat(winningsEl?.textContent?.replace(' TON', '') || '0');
  
  if (currentWinnings < amount) {
    tg.showAlert(`❌ Недостаточно выигрышей! Доступно: ${currentWinnings.toFixed(2)} TON, требуется: ${amount} TON`);
    return;
  }
  
  const buyBtn = document.getElementById('buy-games-with-winnings-btn');
  if (buyBtn) {
    // Сохраняем оригинальный текст только если еще не сохранен
    if (!buyBtn.dataset.originalText) {
      buyBtn.dataset.originalText = buyBtn.innerHTML;
    }
    
    // ВИЗУАЛЬНАЯ ИНДИКАЦИЯ: блокируем кнопку и показываем состояние загрузки
    buyBtn.disabled = true;
    buyBtn.classList.add('processing');
    buyBtn.innerHTML = '<span>⏳ Processing...</span>';
    buyBtn.style.opacity = '0.7';
    buyBtn.style.cursor = 'not-allowed';
    buyBtn.style.transform = 'scale(0.98)'; // Визуальный отклик нажатия
    
    // Восстанавливаем transform через небольшую задержку для плавности
    setTimeout(() => {
      if (buyBtn) {
        buyBtn.style.transform = '';
      }
    }, 150);
  }
  
  console.log(`📤 Отправляю запрос на покупку ${amount} игр за выигрыши...`);
  
  // Проверяем подключение сокета
  if (!socket || !socket.connected) {
    tg.showAlert('❌ Нет подключения к серверу. Пожалуйста, обновите страницу.');
    // Восстанавливаем кнопку при ошибке подключения
    if (buyBtn) {
      buyBtn.disabled = false;
      buyBtn.classList.remove('processing');
      buyBtn.innerHTML = buyBtn.dataset.originalText || '<span>🔄 Buy Games with Winnings (1 TON = 1 Game)</span>';
      buyBtn.style.opacity = '1';
      buyBtn.style.cursor = 'pointer';
    }
    return;
  }
  
  // Отправляем запрос без callback (ответ придет через socket.on)
  socket.emit('buyGamesWithWinnings', { amount });
}

/**
 * Обновление баланса
 */
function updateBalance(gamesBalance, winningsTon) {
  const gamesEl = document.getElementById('games-balance');
  const winningsEl = document.getElementById('winnings-balance');
  
  if (gamesEl) gamesEl.textContent = gamesBalance || 0;
  if (winningsEl) winningsEl.textContent = `${(winningsTon || 0).toFixed(2)} TON`;
  
  // Показываем/скрываем кнопку покупки игр с выигрышного баланса
  const buyWithWinningsBtn = document.getElementById('buy-games-with-winnings-btn');
  if (buyWithWinningsBtn) {
    const hasWinnings = winningsTon && winningsTon >= 1;
    buyWithWinningsBtn.style.display = hasWinnings ? 'block' : 'none';
  }
}

/**
 * Пополнение баланса (DEBUG_MODE)
 */
async function addGamesBalance(amount) {
  try {
    const response = await fetch(`/api/add-games/${userId}?amount=${amount}`);
    const data = await response.json();
    
    if (data.success) {
      updateBalance(data.games_balance, data.winnings_ton);
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
      // Отключаем сглаживание изображений для четкости
      gameCtx.imageSmoothingEnabled = false;
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
 * Быстрая функция клонирования только нужных полей (оптимизация производительности)
 */
function cloneSnakeState(data) {
  if (!data) return null;
  return {
    my_snake: data.my_snake ? {
      body: data.my_snake.body.map(s => ({ x: s.x, y: s.y })),
      direction: { dx: data.my_snake.direction.dx, dy: data.my_snake.direction.dy },
      alive: data.my_snake.alive
    } : null,
    opponent_snake: data.opponent_snake ? {
      body: data.opponent_snake.body.map(s => ({ x: s.x, y: s.y })),
      direction: { dx: data.opponent_snake.direction.dx, dy: data.opponent_snake.direction.dy },
      alive: data.opponent_snake.alive
    } : null
  };
}

/**
 * Обновление состояния игры - упрощенная версия
 * Использует быстрое клонирование вместо JSON.parse/stringify
 */
function updateGameState(data) {
  // Сохраняем предыдущее состояние перед обновлением
  previousGameStateData = gameStateData;
  
  // Обновляем текущее состояние (клонируем серверные данные)
  gameStateData = cloneSnakeState(data);
  
  // Обновляем время последнего обновления
  lastGameStateUpdate = performance.now();
  
  // Запускаем цикл отрисовки если он еще не запущен
  if (!animationFrameId && gameState === 'playing') {
    startRenderLoop();
  }
}

// Цикл отрисовки с requestAnimationFrame (60 FPS)
// Чистая интерполяция без client-side prediction + Jitter Buffer
function startRenderLoop() {
  if (animationFrameId) return; // Уже запущен
  
  // Инициализация offscreen canvas для сетки (один раз)
  if (!gridCanvas) {
    gridCanvas = document.createElement('canvas');
    gridCanvas.width = canvasLogicalSize;
    gridCanvas.height = canvasLogicalSize;
    gridCtx = gridCanvas.getContext('2d');
    drawGridToOffscreen(); // Рисуем сетку один раз на offscreen canvas
  }
  
  function render() {
    if (gameState !== 'playing' || !gameCanvas || !gameCtx) {
      animationFrameId = null;
      return;
    }
    
    // Рассчитываем локальную переменную t для интерполяции
    // Используем "игровое время" с задержкой для плавной интерполяции
    const renderTime = performance.now() - INTERPOLATION_OFFSET;
    const timeSinceUpdate = renderTime - lastGameStateUpdate;
    
    // Рассчитываем t для интерполяции (строгое ограничение без экстраполяции)
    let t = timeSinceUpdate / 111.11;
    t = Math.max(0, Math.min(t, 1)); // Строгое ограничение без экстраполяции
    
    // Отрисовываем только если есть данные
    if (gameStateData && gameStateData.my_snake && gameStateData.opponent_snake) {
      // Полная очистка canvas перед каждым кадром
      gameCtx.clearRect(0, 0, canvasLogicalSize, canvasLogicalSize);
      
      // Фон для игрового поля
      gameCtx.fillStyle = '#0a0e27';
      gameCtx.fillRect(0, 0, canvasLogicalSize, canvasLogicalSize);
      
      // ОПТИМИЗАЦИЯ: используем offscreen canvas для сетки вместо перерисовки
      if (gridCanvas) {
        gameCtx.drawImage(gridCanvas, 0, 0);
      } else {
        // Fallback: если offscreen canvas не создан, рисуем сетку обычным способом
        drawGrid();
      }
      
      // INTERPOLATION: плавное движение между обновлениями сервера
      // Используем интерполяцию только если есть предыдущее состояние
      let mySnake, opponentSnake;
      
      if (previousGameStateData && previousGameStateData.my_snake && previousGameStateData.opponent_snake) {
        // Есть предыдущее состояние - интерполируем
        mySnake = interpolateSnake(previousGameStateData.my_snake, gameStateData.my_snake, t);
        opponentSnake = interpolateSnake(previousGameStateData.opponent_snake, gameStateData.opponent_snake, t);
      } else {
        // Нет предыдущего состояния (первое обновление) - используем текущее состояние
        mySnake = gameStateData.my_snake;
        opponentSnake = gameStateData.opponent_snake;
      }
      
      // Отрисовываем змейки (без экстраполяции - просто интерполированные данные)
      drawSnake(mySnake, '#ff4444', '#ff6666');
      drawSnake(opponentSnake, '#4444ff', '#6666ff');
    }
    
    // Продолжаем цикл
    animationFrameId = requestAnimationFrame(render);
  }
  
  animationFrameId = requestAnimationFrame(render);
}

/**
 * Рисование сетки на offscreen canvas (один раз для оптимизации)
 */
function drawGridToOffscreen() {
  if (!gridCtx) return;
  
  const tileSize = canvasLogicalSize / 30; // 30 клеток по ширине
  const width = canvasLogicalSize;
  const height = canvasLogicalSize;
  
  // Более яркие линии сетки для лучшей видимости
  gridCtx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
  gridCtx.lineWidth = 0.5;
  
  for (let i = 0; i <= 30; i++) {
    // Vertical lines
    gridCtx.beginPath();
    gridCtx.moveTo(i * tileSize, 0);
    gridCtx.lineTo(i * tileSize, height);
    gridCtx.stroke();
    
    // Horizontal lines
    gridCtx.beginPath();
    gridCtx.moveTo(0, i * tileSize);
    gridCtx.lineTo(width, i * tileSize);
    gridCtx.stroke();
  }
}

// Останавливаем цикл отрисовки
function stopRenderLoop() {
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
}

/**
 * Интерполяция змейки для плавного движения между обновлениями сервера
 * Использует чистую линейную интерполяцию (lerp) без сглаживания
 */
function interpolateSnake(previousSnake, currentSnake, t) {
  // Если нет данных - возвращаем текущее состояние
  if (!currentSnake || !currentSnake.body) {
    return currentSnake;
  }
  
  // Если нет предыдущего состояния - возвращаем текущее без интерполяции
  if (!previousSnake || !previousSnake.body) {
    return currentSnake;
  }
  
  // Если длина изменилась, не интерполируем (просто возвращаем текущее состояние)
  if (previousSnake.body.length !== currentSnake.body.length) {
    return currentSnake;
  }
  
  // Ограничиваем t до [0, 1] для интерполяции
  const interpolationT = Math.min(Math.max(t, 0), 1);
  
  // Создаем новый объект змейки (быстрое клонирование)
  const interpolated = {
    body: [],
    direction: { ...currentSnake.direction },
    alive: currentSnake.alive
  };
  
  // Направление меняется мгновенно (без плавной интерполяции)
  interpolated.direction = { ...currentSnake.direction };
  
  // Интерполируем каждую позицию сегмента строго линейно
  // Используем только чистую линейную интерполяцию: prev + (curr - prev) * t
  interpolated.body = currentSnake.body.map((segment, index) => {
    if (index >= previousSnake.body.length) return { x: segment.x, y: segment.y };
    
    const prevSegment = previousSnake.body[index];
    const dx = segment.x - prevSegment.x;
    const dy = segment.y - prevSegment.y;
    
    // Строго линейная интерполяция: prevSegment + (currentSegment - prevSegment) * t
    return {
      x: prevSegment.x + dx * interpolationT,
      y: prevSegment.y + dy * interpolationT
    };
  });
  
  return interpolated;
}

/**
 * Рисование сетки (современный дизайн)
 */
function drawGrid() {
  // Используем логический размер canvas (без DPR) для корректной отрисовки
  const tileSize = canvasLogicalSize / 30; // 30 клеток по ширине
  const width = canvasLogicalSize;
  const height = canvasLogicalSize;
  
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
  
  // Используем логический размер canvas (без DPR) для корректной отрисовки
  const tileSize = canvasLogicalSize / 30; // 30 клеток по ширине
  
  // Определяем направление змейки для глаз с плавной интерполяцией
  let direction = snake.direction;
  
  // Если direction отсутствует или некорректно, вычисляем из позиций сегментов
  if (!direction || (direction.dx === 0 && direction.dy === 0)) {
    if (snake.body.length > 1) {
      // Вычисляем направление из первых двух сегментов для более точного отображения
      const head = snake.body[0];
      const next = snake.body[1];
      const dx = head.x - next.x;
      const dy = head.y - next.y;
      const length = Math.sqrt(dx * dx + dy * dy);
      
      if (length > 0) {
        direction = { dx: dx / length, dy: dy / length };
      } else {
        // Если сегменты на одной позиции, используем направление по умолчанию
        direction = color1 === '#ff4444' ? { dx: 1, dy: 0 } : { dx: -1, dy: 0 };
      }
    } else {
      // По умолчанию: красная змейка вправо, синяя влево
      direction = color1 === '#ff4444' ? { dx: 1, dy: 0 } : { dx: -1, dy: 0 };
    }
  }
  
  // Нормализуем направление для корректного отображения (должно быть единичным вектором)
  const dirLength = Math.sqrt(direction.dx * direction.dx + direction.dy * direction.dy);
  if (dirLength > 0.01) { // Проверка на ненулевое направление
    direction = { dx: direction.dx / dirLength, dy: direction.dy / dirLength };
  } else {
    direction = { dx: 1, dy: 0 }; // Fallback
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
      
      // Вычисляем позицию глаз в зависимости от направления (с учетом плавного поворота)
      // Используем нормализованное направление для более точного позиционирования
      const absDx = Math.abs(direction.dx);
      const absDy = Math.abs(direction.dy);
      
      if (absDx > absDy) {
        // Горизонтальное движение (влево или вправо)
        if (direction.dx > 0) {
          // Движется вправо - глаза справа
          eyeX1 = centerX + eyeOffset * 0.5;
          eyeY1 = centerY - eyeOffset * 0.5;
          eyeX2 = centerX + eyeOffset * 0.5;
          eyeY2 = centerY + eyeOffset * 0.5;
        } else {
          // Движется влево - глаза слева
          eyeX1 = centerX - eyeOffset * 0.5;
          eyeY1 = centerY - eyeOffset * 0.5;
          eyeX2 = centerX - eyeOffset * 0.5;
          eyeY2 = centerY + eyeOffset * 0.5;
        }
      } else {
        // Вертикальное движение (вверх или вниз)
        if (direction.dy > 0) {
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
        ? `You won ${prize.toFixed(2)} TON!` 
        : 'You lost';
    } else {
      // If connection lost or data didn't arrive
      resultMessage.textContent = data ? 'Connection lost' : 'Match ended';
    }
  }
  
  if (resultPrize) {
    resultPrize.textContent = isWinner ? `💰 +${prize.toFixed(2)} TON` : '💰 0 TON';
  }
  
  // Баланс обновляется через socket.on('balance_updated') от сервера
  // Не вызываем updateBalance() без параметров!
  
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

