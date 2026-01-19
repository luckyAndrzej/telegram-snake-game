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

// Client-side Prediction: локальное состояние змейки для мгновенного отклика
let predictedSnakeState = null; // Локально предсказанное состояние моей змейки
let lastServerState = null; // Последнее состояние от сервера для reconciliation
let pendingDirections = []; // Очередь направлений, отправленных на сервер
let lastDirectionSentTime = 0; // Время последней отправки направления

// Инициализация
document.addEventListener('DOMContentLoaded', () => {
  console.log('🚀 Инициализация приложения...');
  
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
        
        // Если игра активна, перерисовываем состояние
        if (gameState === 'playing' && currentGame && gameStateData) {
          // Быстрая перерисовка текущего состояния
          requestAnimationFrame(() => {
            if (gameCtx && gameStateData) {
              gameCtx.clearRect(0, 0, maxCanvasSize, maxCanvasSize);
              gameCtx.fillStyle = '#0a0e27';
              gameCtx.fillRect(0, 0, maxCanvasSize, maxCanvasSize);
              drawGrid();
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
    }
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
    
    // CLIENT-SIDE PREDICTION: инициализируем предсказанное состояние
    predictedSnakeState = null;
    lastServerState = null;
    pendingDirections = [];
    lastDirectionSentTime = 0;
    
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
    const paymentModal = document.getElementById('payment-modal');
    if (paymentModal) {
      paymentModal.style.display = 'none';
    }
    
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
    updateBalance(data.games_balance, data.winnings_ton);
    
    // Восстанавливаем текст кнопки
    const buyBtn = document.getElementById('buy-games-with-winnings-btn');
    if (buyBtn) {
      buyBtn.disabled = false;
      buyBtn.innerHTML = '<span>🔄 Buy Games with Winnings (1 TON = 1 Game)</span>';
    }
    
    tg.showAlert(`✅ Куплено ${data.games_purchased} игр за ${data.games_purchased} TON выигрышей!`);
  });
  
  // Обработчик ошибки покупки игр с выигрышного баланса
  socket.on('buy_games_error', (data) => {
    const errorMessage = data.message || 'Ошибка при покупке игр';
    
    // Восстанавливаем текст кнопки при ошибке
    const buyBtn = document.getElementById('buy-games-with-winnings-btn');
    if (buyBtn) {
      buyBtn.disabled = false;
      buyBtn.innerHTML = '<span>🔄 Buy Games with Winnings (1 TON = 1 Game)</span>';
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

        paymentModal.style.display = 'flex';
        
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
    handleBuyGamesWithWinnings(1); // По умолчанию 1 игра за 1 TON
  });
  
  // Withdrawal modal buttons
  document.getElementById('confirm-withdrawal-btn')?.addEventListener('click', () => {
    confirmWithdrawal();
  });
  
  document.getElementById('close-withdrawal-btn')?.addEventListener('click', () => {
    const withdrawalModal = document.getElementById('withdrawal-modal');
    if (withdrawalModal) {
      withdrawalModal.style.display = 'none';
    }
  });
  
  // Close withdrawal modal when clicking outside
  document.getElementById('withdrawal-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'withdrawal-modal') {
      e.target.style.display = 'none';
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
    document.getElementById('payment-modal').style.display = 'none';
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
  
  // Оптимизация производительности: отключаем сглаживание для пиксельной графики
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
 * Отправка команды направления с проверкой на поворот на 180° (моментальный отклик)
 * + Client-side Prediction: мгновенное обновление локального состояния
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
  
  // CLIENT-SIDE PREDICTION: мгновенно обновляем локальное состояние змейки
  if (predictedSnakeState && gameStateData && gameStateData.my_snake) {
    const newDirection = {
      'up': { dx: 0, dy: -1 },
      'down': { dx: 0, dy: 1 },
      'left': { dx: -1, dy: 0 },
      'right': { dx: 1, dy: 0 }
    }[direction];
    
    if (newDirection) {
      // Обновляем направление в предсказанном состоянии
      predictedSnakeState.direction = newDirection;
      
      // Сохраняем команду в очередь для reconciliation
      const commandId = Date.now();
      pendingDirections.push({
        id: commandId,
        direction: newDirection,
        timestamp: performance.now()
      });
      
      // Обновляем currentDirection для следующей проверки
      currentDirection = direction;
    }
  }
  
  // Моментально отправляем команду на сервер (без задержек)
  socket.emit('direction', direction);
  lastDirectionSentTime = performance.now();
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
 * Обработка фокуса на поле ввода адреса для корректной работы с клавиатурой
 */
function setupWithdrawalInputHandlers() {
  const withdrawalInput = document.getElementById('withdrawal-address-input');
  const withdrawalModal = document.getElementById('withdrawal-modal');
  
  if (withdrawalInput && withdrawalModal) {
    // При фокусе на input прокручиваем модалку в видимую область
    withdrawalInput.addEventListener('focus', () => {
      setTimeout(() => {
        const modalContent = withdrawalModal.querySelector('.payment-modal-content');
        if (modalContent) {
          modalContent.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 300); // Небольшая задержка для появления клавиатуры
    });
    
    // При потере фокуса возвращаем модалку в центр
    withdrawalInput.addEventListener('blur', () => {
      const modalContent = withdrawalModal.querySelector('.payment-modal-content');
      if (modalContent) {
        modalContent.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
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
  
  // Обработчик фокуса на input - сдвигаем модальное окно вверх для клавиатуры
  const handleInputFocus = () => {
    const modalContent = withdrawalModal.querySelector('.payment-modal-content');
    if (modalContent) {
      modalContent.style.transform = 'translate(-50%, -30%)';
    }
  };
  
  const handleInputBlur = () => {
    const modalContent = withdrawalModal.querySelector('.payment-modal-content');
    if (modalContent) {
      modalContent.style.transform = '';
    }
  };
  
  // Удаляем старые обработчики если они есть
  withdrawalAddressInput.removeEventListener('focus', handleInputFocus);
  withdrawalAddressInput.removeEventListener('blur', handleInputBlur);
  
  // Добавляем новые обработчики
  withdrawalAddressInput.addEventListener('focus', handleInputFocus);
  withdrawalAddressInput.addEventListener('blur', handleInputBlur);
  
  // Показываем модальное окно
  withdrawalModal.style.display = 'flex';
  
  // Прокручиваем к полю ввода если нужно
  setTimeout(() => {
    withdrawalAddressInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 100);
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
      if (withdrawalModal) {
        withdrawalModal.style.display = 'none';
      }
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
    buyBtn.disabled = true;
    buyBtn.innerHTML = '<span>⏳ Processing...</span>';
  }
  
  console.log(`📤 Отправляю запрос на покупку ${amount} игр за выигрыши...`);
  
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
 * Обновление состояния игры с оптимизацией и requestAnimationFrame
 */
// Состояние игры для интерполяции
let gameStateData = null;
let previousGameStateData = null; // Предыдущее состояние для интерполяции
let lastGameStateUpdate = 0;
let animationFrameId = null;
let interpolationTime = 0; // Время с последнего обновления состояния

// Функция для сохранения данных от сервера (не блокирует отрисовку)
// + Server Reconciliation: плавная коррекция позиции при расхождении
function updateGameState(data) {
  // Проверка данных змеек
  if (!data || !data.my_snake || !data.opponent_snake) {
    console.warn('⚠️ Ошибка: данные змейки не получены!', { data });
    return;
  }
  
  if (!data.my_snake.body || !Array.isArray(data.my_snake.body) || data.my_snake.body.length === 0) {
    console.warn('⚠️ Ошибка: массив сегментов my_snake пуст или undefined!', { my_snake: data.my_snake });
    return;
  }
  
  if (!data.opponent_snake.body || !Array.isArray(data.opponent_snake.body) || data.opponent_snake.body.length === 0) {
    console.warn('⚠️ Ошибка: массив сегментов opponent_snake пуст или undefined!', { opponent_snake: data.opponent_snake });
    return;
  }
  
  // Сохраняем предыдущее состояние для интерполяции
  if (gameStateData) {
    previousGameStateData = JSON.parse(JSON.stringify(gameStateData));
  }
  
  // SERVER RECONCILIATION: проверяем расхождение между предсказанием и сервером
  if (predictedSnakeState && data.my_snake && data.my_snake.body && data.my_snake.body.length > 0) {
    const serverHead = data.my_snake.body[0];
    const predictedHead = predictedSnakeState.body && predictedSnakeState.body.length > 0 
      ? predictedSnakeState.body[0] 
      : null;
    
    if (predictedHead) {
      // Вычисляем расстояние между предсказанной и серверной позицией головы
      const tileSize = canvasLogicalSize / 30;
      const dx = (serverHead.x - predictedHead.x) * tileSize;
      const dy = (serverHead.y - predictedHead.y) * tileSize;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      // Если расхождение больше 5-10 пикселей, корректируем плавно
      if (distance > 10) {
        // Плавная коррекция: используем интерполяцию для сглаживания
        // Серверное состояние становится "целевым" для интерполяции
        console.log(`🔧 Reconciliation: коррекция позиции (расхождение: ${distance.toFixed(1)}px)`);
      }
      
      // Удаляем обработанные команды из очереди (команды, которые уже обработаны сервером)
      // Простая эвристика: удаляем команды старше 500ms (время RTT)
      const now = performance.now();
      pendingDirections = pendingDirections.filter(cmd => (now - cmd.timestamp) < 1000);
    }
  }
  
  // Обновляем предсказанное состояние на основе серверного (базовая синхронизация)
  if (data.my_snake) {
    predictedSnakeState = JSON.parse(JSON.stringify(data.my_snake));
  }
  
  // Сохраняем серверное состояние для reconciliation
  lastServerState = JSON.parse(JSON.stringify(data));
  
  // CLIENT-SIDE PREDICTION: синхронизируем предсказанное состояние с сервером
  // При получении нового состояния от сервера, обновляем базовое состояние для предсказания
  if (data.my_snake) {
    // Если предсказанное состояние еще не инициализировано, создаем его
    if (!predictedSnakeState) {
      predictedSnakeState = JSON.parse(JSON.stringify(data.my_snake));
    } else {
      // Синхронизируем: обновляем базовое состояние, но сохраняем текущее направление если есть pending команды
      const currentPredictedDirection = predictedSnakeState.direction;
      predictedSnakeState = JSON.parse(JSON.stringify(data.my_snake));
      
      // Если есть pending команды (недавно отправленные), применяем их направление
      if (pendingDirections.length > 0) {
        const latestCommand = pendingDirections[pendingDirections.length - 1];
        if (latestCommand && latestCommand.direction) {
          predictedSnakeState.direction = latestCommand.direction;
        }
      } else if (currentPredictedDirection) {
        // Если нет pending команд, но было предсказанное направление, сохраняем его
        // (на случай, если сервер еще не обработал команду)
        predictedSnakeState.direction = currentPredictedDirection;
      }
    }
  }
  
  // Сохраняем данные для отрисовки
  gameStateData = data;
  lastGameStateUpdate = performance.now();
  interpolationTime = 0; // Сброс времени интерполяции
  
  // Обновляем текущее направление
  if (data && data.my_snake && data.my_snake.direction) {
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
  
  // Обновляем статусы игроков (быстрая DOM операция)
  if (data && data.my_snake && data.opponent_snake) {
    const player1Status = document.getElementById('player1-status');
    const player2Status = document.getElementById('player2-status');
    if (player1Status) player1Status.textContent = `You: ${data.my_snake.alive ? 'Alive' : 'Dead'}`;
    if (player2Status) player2Status.textContent = `Opponent: ${data.opponent_snake.alive ? 'Alive' : 'Dead'}`;
  }
  
  // Запускаем цикл отрисовки если он еще не запущен
  if (!animationFrameId && gameState === 'playing') {
    startRenderLoop();
  }
}

// Цикл отрисовки с requestAnimationFrame (60 FPS)
// + Client-side Prediction: используем предсказанное состояние для мгновенного отклика
// + Interpolation: плавное движение между обновлениями сервера
function startRenderLoop() {
  if (animationFrameId) return; // Уже запущен
  
  function render() {
    if (gameState !== 'playing' || !gameCanvas || !gameCtx) {
      animationFrameId = null;
      return;
    }
    
    // Обновляем время интерполяции (для плавного движения между обновлениями сервера)
    const currentTime = performance.now();
    if (lastGameStateUpdate > 0) {
      // Нормализуем к 0-1 (50ms между обновлениями при 20 FPS от сервера)
      const serverUpdateInterval = 50; // 20 обновлений в секунду = 50ms
      interpolationTime = Math.min((currentTime - lastGameStateUpdate) / serverUpdateInterval, 1);
    }
    
    // CLIENT-SIDE PREDICTION: обновляем предсказанное состояние локально
    // Применяем локальное движение на основе текущего направления для мгновенного отклика
    if (predictedSnakeState && predictedSnakeState.direction && predictedSnakeState.body && predictedSnakeState.body.length > 0) {
      // Вычисляем время с последнего обновления сервера
      const timeSinceLastUpdate = (currentTime - lastGameStateUpdate) / 1000; // в секундах
      
      // Если прошло достаточно времени (> 30ms), применяем локальное движение
      // Это создает эффект мгновенного отклика при нажатии клавиши
      if (timeSinceLastUpdate > 0.03 && lastServerState && lastServerState.my_snake) {
        // Используем направление из предсказанного состояния для локального движения
        const dir = predictedSnakeState.direction;
        const head = predictedSnakeState.body[0];
        
        // Вычисляем новую позицию головы на основе направления
        // Учитываем, что змейка движется по сетке (целые числа)
        const newHead = {
          x: head.x + dir.dx * (timeSinceLastUpdate * 6), // 6 клеток в секунду (соответствует TICK_RATE)
          y: head.y + dir.dy * (timeSinceLastUpdate * 6)
        };
        
        // Округляем до ближайшей клетки для корректного отображения
        newHead.x = Math.round(newHead.x);
        newHead.y = Math.round(newHead.y);
        
        // Обновляем предсказанное состояние (двигаем змейку вперед)
        if (predictedSnakeState.body.length > 0) {
          // Добавляем новую голову и удаляем хвост (если длина не изменилась)
          predictedSnakeState.body.unshift(newHead);
          // Сохраняем длину змейки из серверного состояния
          const serverLength = lastServerState.my_snake.body ? lastServerState.my_snake.body.length : predictedSnakeState.body.length;
          if (predictedSnakeState.body.length > serverLength) {
            predictedSnakeState.body.pop();
          }
        }
      }
    }
    
    // Отрисовываем только если есть данные
    if (gameStateData && gameStateData.my_snake && gameStateData.opponent_snake) {
      // Эффективная очистка canvas (используем логический размер после ctx.scale)
      gameCtx.clearRect(0, 0, canvasLogicalSize, canvasLogicalSize);
      
      // Фон для игрового поля (используем логический размер)
      gameCtx.fillStyle = '#0a0e27';
      gameCtx.fillRect(0, 0, canvasLogicalSize, canvasLogicalSize);
      
      // Рисуем сетку
      drawGrid();
      
      // INTERPOLATION: плавное движение между обновлениями сервера
      const interpolatedMySnake = interpolateSnake(previousGameStateData?.my_snake, gameStateData.my_snake, interpolationTime);
      const interpolatedOpponentSnake = interpolateSnake(previousGameStateData?.opponent_snake, gameStateData.opponent_snake, interpolationTime);
      
      // CLIENT-SIDE PREDICTION: используем предсказанное состояние для моей змейки, если оно есть
      const snakeToDraw = (predictedSnakeState && interpolationTime < 0.5) 
        ? mergePredictedWithServer(predictedSnakeState, interpolatedMySnake || gameStateData.my_snake, interpolationTime)
        : (interpolatedMySnake || gameStateData.my_snake);
      
      drawSnake(snakeToDraw, '#ff4444', '#ff6666');
      drawSnake(interpolatedOpponentSnake || gameStateData.opponent_snake, '#4444ff', '#6666ff');
    }
    
    // Продолжаем цикл
    animationFrameId = requestAnimationFrame(render);
  }
  
  animationFrameId = requestAnimationFrame(render);
}

/**
 * Объединение предсказанного состояния с серверным для плавного перехода
 */
function mergePredictedWithServer(predicted, server, t) {
  if (!predicted || !server || !predicted.body || !server.body) {
    return server;
  }
  
  // Если расхождение небольшое (< 5px), используем предсказанное состояние
  // Если большое, плавно переходим к серверному
  const tileSize = canvasLogicalSize / 30;
  const predictedHead = predicted.body[0];
  const serverHead = server.body[0];
  
  if (predictedHead && serverHead) {
    const dx = (serverHead.x - predictedHead.x) * tileSize;
    const dy = (serverHead.y - predictedHead.y) * tileSize;
    const distance = Math.sqrt(dx * dx + dy * dy);
    
    // Если расхождение меньше 5 пикселей, используем предсказанное состояние
    if (distance < 5) {
      return predicted;
    }
    
    // Иначе плавно интерполируем между предсказанным и серверным
    const blendFactor = Math.min(t * 2, 1); // Ускоряем переход при большом расхождении
    const merged = JSON.parse(JSON.stringify(server));
    
    if (merged.body && predicted.body && merged.body.length === predicted.body.length) {
      merged.body = merged.body.map((segment, i) => {
        if (i < predicted.body.length) {
          return {
            x: predicted.body[i].x + (segment.x - predicted.body[i].x) * blendFactor,
            y: predicted.body[i].y + (segment.y - predicted.body[i].y) * blendFactor
          };
        }
        return segment;
      });
    }
    
    return merged;
  }
  
  return server;
}

// Останавливаем цикл отрисовки
function stopRenderLoop() {
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
}

/**
 * Интерполяция змейки для плавного движения
 */
function interpolateSnake(previousSnake, currentSnake, t) {
  if (!previousSnake || !currentSnake || !previousSnake.body || !currentSnake.body) {
    return currentSnake;
  }
  
  // Клонируем текущую змейку
  const interpolated = JSON.parse(JSON.stringify(currentSnake));
  
  // Интерполируем каждую позицию сегмента
  if (interpolated.body && previousSnake.body) {
    const maxLength = Math.max(interpolated.body.length, previousSnake.body.length);
    
    for (let i = 0; i < maxLength; i++) {
      if (i < interpolated.body.length && i < previousSnake.body.length) {
        const prev = previousSnake.body[i];
        const curr = interpolated.body[i];
        
        // Линейная интерполяция координат
        interpolated.body[i] = {
          x: prev.x + (curr.x - prev.x) * t,
          y: prev.y + (curr.y - prev.y) * t
        };
      }
    }
  }
  
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
 * Интерполяция змейки между двумя состояниями для плавного движения
 */
function interpolateSnake(previousSnake, currentSnake, t) {
  if (!previousSnake || !currentSnake || !previousSnake.body || !currentSnake.body) {
    return currentSnake; // Если нет предыдущего состояния, возвращаем текущее
  }
  
  if (previousSnake.body.length !== currentSnake.body.length) {
    return currentSnake; // Если длина изменилась, не интерполируем
  }
  
  // Клонируем текущую змейку
  const interpolated = JSON.parse(JSON.stringify(currentSnake));
  
  // Интерполируем каждую позицию сегмента
  interpolated.body = currentSnake.body.map((segment, index) => {
    if (index >= previousSnake.body.length) return segment;
    
    const prevSegment = previousSnake.body[index];
    const currSegment = segment;
    
    // Плавная интерполяция позиции (lerp)
    return {
      x: prevSegment.x + (currSegment.x - prevSegment.x) * t,
      y: prevSegment.y + (currSegment.y - prevSegment.y) * t
    };
  });
  
  return interpolated;
}

/**
 * Рисование змейки (современный дизайн с градиентами, neon эффектом и глазами по направлению)
 */
function drawSnake(snake, color1, color2) {
  if (!snake || !snake.body || snake.body.length === 0) return;
  
  // Используем логический размер canvas (без DPR) для корректной отрисовки
  const tileSize = canvasLogicalSize / 30; // 30 клеток по ширине
  
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

