/**
 * Telegram Mini App - Frontend
 * Мультиплеерная игра "Змейка"
 */

// Telegram Web App API
const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();

// STATE MANAGEMENT: Единое состояние приложения
// Все данные сначала записываются в window.appState, затем вызывается рендер
window.appState = {
  user: {
    id: null,
    username: null,
    games_balance: 0,
    winnings_ton: 0
  },
  game: {
    snakes: [],
    status: 'menu', // menu, countdown, playing, finished
    my_snake: null,
    opponent_snake: null,
    tick_number: 0,
    finished: false
  }
};

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
let canvasInitialized = false; // Флаг инициализации Canvas (СИНГЛТОН)
let canvasDPR = 1; // Сохраненный DPR для стабильности
const GRID_SIZE = 30; // СИНХРОНИЗАЦИЯ СЕТКИ: размер игрового поля строго 30x30 (совпадает с сервером)

// STABLE PLAYBACK QUEUE: простая очередь пакетов
let packetQueue = []; // Очередь пакетов game_state

// Фиксированный шаг тика сервера (увеличено до 120мс для компенсации сетевых задержек)
const TICK_DURATION = 120; // мс (длительность одного тика на сервере)

// Текущее состояние игры для отрисовки
let previousGameState = null; // Предыдущее состояние для интерполяции
let interpolatedGameState = null; // Текущее состояние для интерполяции (не путать с currentGameState)
let lastStateUpdateTime = 0; // Время последнего обновления состояния
let headHistory = []; // История позиций головы для хвоста (массив {x, y, direction})
let opponentHeadHistory = []; // История позиций головы противника

// Время последнего шага
let lastStepTime = 0;

let animationFrameId = null;
let isRendering = false; // Флаг для контроля рендеринга
let countdownValue = ""; // Глобальная переменная для значения отсчета

// IN-MEMORY STATE: JSON-объект для хранения состояния игры в оперативной памяти
// Этот объект живет только во время матча и используется для плавной отрисовки
// В БД записываются только финальные результаты после завершения игры
let gameStateJSON = {
  tick_number: 0,
  my_snake: null,
  opponent_snake: null,
  finished: false,
  game_finished: false
};

// CURRENT GAME STATE: Объект для хранения текущего состояния игры
// Используется для синхронизации отрисовки и управления состоянием
let currentGameState = {
  snakes: [],
  status: 'idle', // idle, countdown, playing, finished
  my_snake: null,
  opponent_snake: null
};

// Input Buffer: очередь команд для предотвращения потери быстрых нажатий
let inputBuffer = [];
let lastDirectionSentTime = 0;
const INPUT_BUFFER_DELAY = 0; // Немедленная отправка для мгновенного отклика

// Offscreen canvas для сетки (оптимизация отрисовки)
let gridCanvas = null;
let gridCtx = null;


/**
 * Универсальная функция для открытия/закрытия модальных окон
 */
function toggleModal(modalId, show) {
  // ОПТИМИЗАЦИЯ: Обновляем баланс после закрытия модального окна
  if (!show && (modalId === 'payment-modal' || modalId === 'withdrawal-modal')) {
    // Небольшая задержка для завершения анимации закрытия
    setTimeout(() => {
      refreshUserProfile();
    }, 300);
  }
  const modal = document.getElementById(modalId);
  if (!modal) return;
  
  if (show) {
    // Очистка инлайновых стилей перед показом
    modal.style.display = '';
    modal.style.opacity = '';
    modal.style.transform = '';
    
    // Убеждаемся, что content правильно центрирован
    const content = modal.querySelector('.payment-modal-content');
    if (content) {
      content.style.left = '';
      content.style.top = '';
      content.style.right = '';
      content.style.transform = '';
      content.style.margin = '';
    }
    
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
  
  // ФИКСАЦИЯ VIEWPORT: оптимизируем обработку событий Telegram WebApp
  // Не пересоздаем Canvas при изменении размера окна - используем фиксированный размер
  let resizeTimeout;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      // НЕ пересоздаем Canvas при resize - используем фиксированный размер для стабильности
      // Canvas уже инициализирован с фиксированным размером, не меняем его
      if (gameCanvas && canvasInitialized) {
        console.log('⚠️ Resize событие проигнорировано для стабильности Canvas');
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
    
    // STATE MANAGEMENT: Обновляем window.appState перед обновлением UI
    window.appState.user.games_balance = data.games_balance || 0;
    window.appState.user.winnings_ton = data.winnings_ton || 0;
    window.appState.user.id = data.id || userId;
    window.appState.user.username = data.username || username;
    
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
        // ИНИЦИАЛИЗАЦИЯ ПОЗИЦИЙ: валидируем initial_state перед использованием
        const initialState = data.initial_state;
        
        currentGame.initialState = initialState;
        console.log('✅ Initial game state received and validated');
        
        // STATE MANAGEMENT: Обновляем window.appState из initial_state
        window.appState.game.status = 'countdown';
        // ПОЗИЦИОНИРОВАНИЕ НА СТАРТЕ: Принудительно устанавливаем горизонтальное положение змеек
        // Игрок 1: голова на x=5, y=15, хвост тянется вправо
        // Игрок 2: голова на x=24, y=15, хвост тянется влево
        // ИСПРАВЛЕНИЕ: В initial_state принудительно установи змейкам горизонтальное положение
        // УДАЛЕНИЕ ДУБЛИКАТА: Объявляем переменные только один раз
        const mySnakeSegments = initialState.my_snake?.segments || initialState.my_snake?.body;
        const opponentSnakeSegments = initialState.opponent_snake?.segments || initialState.opponent_snake?.body;
        
        // Валидация координат в initial_state (используем уже объявленные переменные)
        if (mySnakeSegments && mySnakeSegments[0]) {
          const mySnakeHead = mySnakeSegments[0];
          if (mySnakeHead && (mySnakeHead.x < 0 || mySnakeHead.x >= GRID_SIZE || mySnakeHead.y < 0 || mySnakeHead.y >= GRID_SIZE)) {
            console.error(`❌ CRITICAL: Invalid my_snake initial position: x=${mySnakeHead.x}, y=${mySnakeHead.y}`);
          }
        }
        if (opponentSnakeSegments && opponentSnakeSegments[0]) {
          const opponentSnakeHead = opponentSnakeSegments[0];
          if (opponentSnakeHead && (opponentSnakeHead.x < 0 || opponentSnakeHead.x >= GRID_SIZE || opponentSnakeHead.y < 0 || opponentSnakeHead.y >= GRID_SIZE)) {
            console.error(`❌ CRITICAL: Invalid opponent_snake initial position: x=${opponentSnakeHead.x}, y=${opponentSnakeHead.y}`);
          }
        }
        
        // ПРИНУДИТЕЛЬНОЕ ГОРИЗОНТАЛЬНОЕ ПОЛОЖЕНИЕ: Если сегменты невалидны или змейка уходит за край, устанавливаем правильные координаты
        let fixedMySnakeSegments = mySnakeSegments;
        let fixedOpponentSnakeSegments = opponentSnakeSegments;
        
        // ЛОГИКА КООРДИНАТ: Если в логах видишь x = -1, значит змейка движется влево слишком быстро
        // В initial_state принудительно задаем горизонтальное положение
        if (!mySnakeSegments || mySnakeSegments.length === 0 || (mySnakeSegments[0] && (mySnakeSegments[0].x < 0 || mySnakeSegments[0].x >= GRID_SIZE))) {
          // Змейка 1 (Player 1): segments: [{x: 5, y: 15}, {x: 4, y: 15}, {x: 3, y: 15}] (горизонтально)
          // Горизонтальное положение — это когда у сегментов одинаковый y, а x меняется
          fixedMySnakeSegments = [
            { x: 5, y: 15 },
            { x: 4, y: 15 },
            { x: 3, y: 15 }
          ];
          console.log('🔧 Fixed my_snake initial position to horizontal:', fixedMySnakeSegments);
        }
        
        if (!opponentSnakeSegments || opponentSnakeSegments.length === 0 || (opponentSnakeSegments[0] && (opponentSnakeSegments[0].x < 0 || opponentSnakeSegments[0].x >= GRID_SIZE))) {
          // Змейка 2 (Player 2): segments: [{x: 24, y: 15}, {x: 25, y: 15}, {x: 26, y: 15}] (горизонтально)
          // Горизонтальное положение — это когда у сегментов одинаковый y, а x меняется
          fixedOpponentSnakeSegments = [
            { x: 24, y: 15 },
            { x: 25, y: 15 },
            { x: 26, y: 15 }
          ];
          console.log('🔧 Fixed opponent_snake initial position to horizontal:', fixedOpponentSnakeSegments);
        }
        
        window.appState.game.my_snake = {
          segments: fixedMySnakeSegments || mySnakeSegments || [],
          direction: { dx: 1, dy: 0 }, // Горизонтально вправо
          alive: true
        };
        window.appState.game.opponent_snake = {
          segments: fixedOpponentSnakeSegments || opponentSnakeSegments || [],
          direction: { dx: -1, dy: 0 }, // Горизонтально влево
          alive: true
        };
        window.appState.game.snakes = [window.appState.game.my_snake, window.appState.game.opponent_snake].filter(s => s !== null);
        
        // ОБНОВЛЕНИЕ ИНФОРМАЦИИ О ЗМЕЙКАХ: Показываем, кто за какую змейку играет
        const player1Status = document.getElementById('player1-status');
        const player2Status = document.getElementById('player2-status');
        if (player1Status) {
          player1Status.textContent = 'You are the green snake';
        }
        if (player2Status) {
          player2Status.textContent = 'Opponent - red snake';
        }
        
        // CURRENT GAME STATE: Синхронизируем currentGameState с appState
        currentGameState.status = 'countdown';
        currentGameState.my_snake = window.appState.game.my_snake;
        currentGameState.opponent_snake = window.appState.game.opponent_snake;
        currentGameState.snakes = window.appState.game.snakes;
        
        console.log('✅ window.appState инициализирован из initial_state:', window.appState);
        
        // Инициализируем текущее направление из начального состояния
        if (initialState.my_snake && initialState.my_snake.direction) {
          const dir = initialState.my_snake.direction;
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
        
        // ОПТИМИЗАЦИЯ: Сразу переключаемся на игровой экран при получении initial_state
        gameState = 'countdown'; // Устанавливаем 'countdown' вместо 'playing' до начала игры
        showScreen('game');
      
      // Инициализируем Canvas перед отрисовкой начального состояния
      if (!canvasInitialized) {
        initCanvas();
      }
      
      // Убеждаемся, что Canvas и контекст доступны
      if (!gameCanvas || !gameCtx) {
        gameCanvas = document.getElementById('game-canvas');
        if (gameCanvas) {
          gameCtx = gameCanvas.getContext('2d');
          if (gameCtx) {
            gameCtx.imageSmoothingEnabled = false;
        }
        }
      }
      
      // Показываем countdown overlay (прозрачный, только цифры)
      const countdownOverlay = document.getElementById('countdown-overlay');
      if (countdownOverlay) {
        countdownOverlay.style.display = 'flex';
      } else {
        console.warn('countdown-overlay не найден!');
      }
      
      // ОПТИМИЗАЦИЯ: Сразу вызываем render() для отрисовки начального состояния
      // Используем requestAnimationFrame для гарантии, что Canvas готов
      requestAnimationFrame(() => {
        if (gameCanvas && gameCtx && data.initial_state) {
          // Сохраняем начальное состояние для использования в render()
          if (!currentGame) {
            currentGame = {};
          }
          currentGame.initialState = data.initial_state;
          
          // Отрисовываем начальное состояние
        renderGamePreviewOnCanvas(data.initial_state, gameCanvas, gameCtx);
          console.log('🎨 Начальное состояние отрисовано во время countdown');
          
          // Запускаем цикл render для плавного обновления во время countdown
          if (!animationFrameId) {
            startRenderLoop();
      }
        }
      });
    }
  });
  
  // Обновление countdown (сервер отправляет числа: 5, 4, 3, 2, 1) - overlay поверх game-canvas
  socket.on('countdown', (data) => {
    console.log('⏰ Countdown:', data.number);
    
    // ИСПРАВЛЕНИЕ: Обновляем countdownValue в window.appState.game
    if (window.appState && window.appState.game) {
      window.appState.game.countdownValue = String(data.number);
      window.appState.game.status = 'countdown';
    }
    // Также обновляем глобальную переменную для совместимости
    countdownValue = String(data.number);
    
    // Устанавливаем gameState в 'countdown' для отрисовки
    gameState = 'countdown';
    
    // ОБНОВЛЕНИЕ ИНФОРМАЦИИ О ЗМЕЙКАХ: Показываем, кто за какую змейку играет
    const player1Status = document.getElementById('player1-status');
    const player2Status = document.getElementById('player2-status');
    if (player1Status) {
      player1Status.textContent = 'You are the green snake';
    }
    if (player2Status) {
      player2Status.textContent = 'Opponent - red snake';
    }
    
    // ВИДИМОСТЬ ОТСЧЕТА: Прямо сейчас отсчет перекрыт другими слоями
    // В функции countdown добавляем команду для видимости отсчета
    const gameScreen = document.getElementById('game-screen');
    const lobbyScreen = document.getElementById('lobby-screen');
    if (gameScreen) {
      gameScreen.style.zIndex = '100';
      gameScreen.style.display = 'flex';
    }
    if (lobbyScreen) {
      lobbyScreen.style.display = 'none';
    }
    
    // Показываем header с информацией о змейках
    const gameHeader = document.querySelector('.game-header');
    if (gameHeader) {
      gameHeader.style.display = 'block';
    }
    
    const countdownNumber = document.getElementById('countdown-number');
    if (countdownNumber) {
      // Сбрасываем и устанавливаем новое значение (предотвращает наложение цифр)
      countdownNumber.textContent = '';
      // Используем requestAnimationFrame для плавного обновления
      requestAnimationFrame(() => {
        countdownNumber.textContent = data.number;
      });
    }
    
    // Запускаем рендер-луп, если он еще не запущен
    if (!animationFrameId && gameCanvas && gameCtx) {
      startRenderLoop();
    }
    
    // ОБНОВЛЕНИЕ ИГРОВОГО ПОЛЯ ВО ВРЕМЯ COUNTDOWN: рисуем начальное состояние, чтобы не было черного экрана
    if (gameCanvas && gameCtx && currentGame && currentGame.initialState && !animationFrameId) {
      // Обновляем отрисовку игрового поля во время countdown, чтобы пользователь видел змеек
      // Используем requestAnimationFrame для плавного обновления
      requestAnimationFrame(() => {
      renderGamePreviewOnCanvas(currentGame.initialState, gameCanvas, gameCtx);
        console.log('🎨 Обновлено начальное состояние во время countdown:', data.number);
      });
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
    
    // УДАЛЕНИЕ ОВЕРЛЕЕВ: Принудительно скрываем countdown overlay при старте игры
    const countdownOverlay = document.getElementById('countdown-overlay');
    if (countdownOverlay) {
      countdownOverlay.style.display = 'none';
      countdownOverlay.classList.remove('active');
    }
    const lobbyScreen = document.getElementById('lobby-screen');
    if (lobbyScreen) {
      lobbyScreen.classList.remove('active');
      lobbyScreen.style.display = 'none';
    }
    console.log('✅ Overlay и lobby очищены при game_start');
    
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
    // ИСПРАВЛЕНИЕ: Очищаем очередь только если игра действительно новая
    // Не очищаем если game_state уже приходили (защита от потери данных)
    if (packetQueue.length === 0 || !window.appState?.game?.my_snake) {
      packetQueue = [];
    } else {
      // Если есть данные в очереди, оставляем их (возможно, они для текущей игры)
      console.log(`ℹ️ Сохраняем ${packetQueue.length} пакетов в очереди при game_start`);
    }
    // CURRENT GAME STATE: Сбрасываем currentGameState при сбросе игры
    currentGameState = {
      snakes: [],
      status: 'idle',
      my_snake: null,
      opponent_snake: null
    };
    previousGameState = null; // Очищаем предыдущее состояние
    lastStateUpdateTime = 0; // Сбрасываем время обновления
    headHistory = [];
    opponentHeadHistory = [];
    lastStepTime = 0;
    
    // Скрываем countdown overlay (используем getElementById без объявления переменной, чтобы избежать дубликата)
    const overlayEl = document.getElementById('countdown-overlay');
    if (overlayEl) {
      overlayEl.style.display = 'none';
    }
    
    // СИНГЛТОН CANVAS: инициализируем Canvas только если он еще не инициализирован
    if (!canvasInitialized) {
    initCanvas();
    }
    
    // Очищаем canvas и готовимся к игре (используем логический размер)
    if (gameCanvas && gameCtx) {
      gameCtx.clearRect(0, 0, canvasLogicalSize, canvasLogicalSize);
      gameCtx.fillStyle = '#0a0e27'; // Modern dark blue background
      gameCtx.fillRect(0, 0, canvasLogicalSize, canvasLogicalSize);
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
    
    // СИНХРОНИЗАЦИЯ GAMEID: Проверяем gameId, но не блокируем если ID немного отличается
    // Если игра началась, клиент должен принимать пакеты game_state даже если ID незначительно отличается
    if (data && data.gameId && currentGame && currentGame.gameId) {
      if (data.gameId !== currentGame.gameId) {
        // Проверяем, не является ли это просто другой формат того же ID (например, ...8q vs ...79)
        const currentIdStr = String(currentGame.gameId);
        const dataIdStr = String(data.gameId);
        // Если ID отличаются только последними символами, считаем это допустимым
        if (currentIdStr.slice(0, -2) !== dataIdStr.slice(0, -2)) {
          console.warn(`⚠️ GameID mismatch: current=${currentGame.gameId}, received=${data.gameId}, но продолжаем обработку`);
        } else {
          console.log(`ℹ️ GameID немного отличается (${currentGame.gameId} vs ${data.gameId}), но продолжаем обработку`);
        }
        // Обновляем gameId на новый, чтобы синхронизироваться с сервером
        currentGame.gameId = data.gameId;
      }
    } else if (data && data.gameId && !currentGame) {
      // Если currentGame не существует, создаем его
      currentGame = { gameId: data.gameId };
    }
    
    // ЛОГИКА ОТРИСОВКИ: Обновляем window.appState.game данными из game_state всегда, если gameState === 'playing'
    // Не блокируем отрисовку из-за несовпадения ID - обновляем состояние в любом случае
    if (data && (gameState === 'playing' || gameState === 'countdown')) {
      window.appState.game.status = 'playing';
      window.appState.game.tick_number = data.tick_number || 0;
      // ИСПРАВЛЕНИЕ ДОСТУПА К КООРДИНАТАМ: Сервер присылает segments, а не body
      // ИСПРАВЛЕНИЕ: Гарантируем, что my_snake и opponent_snake всегда обновляются, даже если один из них null
      if (data.my_snake) {
        window.appState.game.my_snake = {
          segments: data.my_snake.segments ? [...data.my_snake.segments] : (data.my_snake.body ? [...data.my_snake.body] : []),
          direction: data.my_snake.direction ? { ...data.my_snake.direction } : { dx: 1, dy: 0 },
          alive: data.my_snake.alive !== undefined ? data.my_snake.alive : true
        };
      } else {
        // Если my_snake не пришла, сохраняем предыдущее состояние
        if (!window.appState.game.my_snake) {
          window.appState.game.my_snake = currentGameState?.my_snake || currentGame?.initialState?.my_snake || null;
        }
      }
      
      if (data.opponent_snake) {
        window.appState.game.opponent_snake = {
          segments: data.opponent_snake.segments ? [...data.opponent_snake.segments] : (data.opponent_snake.body ? [...data.opponent_snake.body] : []),
          direction: data.opponent_snake.direction ? { ...data.opponent_snake.direction } : { dx: -1, dy: 0 },
          alive: data.opponent_snake.alive !== undefined ? data.opponent_snake.alive : true
        };
      } else {
        // Если opponent_snake не пришла, сохраняем предыдущее состояние
        if (!window.appState.game.opponent_snake) {
          window.appState.game.opponent_snake = currentGameState?.opponent_snake || currentGame?.initialState?.opponent_snake || null;
        }
      }
      
      window.appState.game.snakes = [window.appState.game.my_snake, window.appState.game.opponent_snake].filter(s => s !== null);
      window.appState.game.finished = data.finished === true || data.game_finished === true;
      console.log('✅ window.appState обновлен (игнорируя gameId):', {
        my_snake: window.appState.game.my_snake ? `segments: ${window.appState.game.my_snake.segments?.length || 0}` : 'null',
        opponent_snake: window.appState.game.opponent_snake ? `segments: ${window.appState.game.opponent_snake.segments?.length || 0}` : 'null'
      });
      
      // ПРИНУДИТЕЛЬНЫЙ РЕНДЕР: Добавляем принудительный вызов функции отрисовки, если основной цикл requestAnimationFrame почему-то замер
      if (gameState === 'playing' && !animationFrameId) {
        console.log('🔄 Принудительный запуск render loop после обновления window.appState');
        startRenderLoop();
      }
    }
    
    // CURRENT GAME STATE: Синхронизируем currentGameState с appState
    if (data && (gameState === 'playing' || gameState === 'countdown')) {
      currentGameState.status = 'playing';
      currentGameState.my_snake = window.appState.game.my_snake;
      currentGameState.opponent_snake = window.appState.game.opponent_snake;
      currentGameState.snakes = window.appState.game.snakes;
    }
    
    // IN-MEMORY STATE: Обновляем JSON-объект состояния игры в памяти
    // Это состояние используется только для плавной отрисовки и не записывается в БД
    if (data && (gameState === 'playing' || gameState === 'countdown')) {
      gameStateJSON = {
        tick_number: data.tick_number || 0,
        my_snake: window.appState.game.my_snake,
        opponent_snake: window.appState.game.opponent_snake,
        finished: data.finished === true || data.game_finished === true,
        game_finished: data.game_finished === true || data.finished === true
      };
      console.log('✅ gameStateJSON обновлен (in-memory):', gameStateJSON);
    }
    
    // Обновляем состояние игры только если игра активна (после countdown)
    // Проверяем и 'playing' и 'countdown', чтобы не пропустить первые обновления
    // ИСПРАВЛЕНИЕ: Принимаем пакеты даже если currentGame отсутствует (для совместимости)
    if (gameState === 'playing' || gameState === 'countdown') {
      // Если пришло game_state, значит игра уже началась - переключаем на playing
      if (gameState === 'countdown') {
        gameState = 'playing';
        
        // УДАЛЕНИЕ ОВЕРЛЕЕВ: Принудительно очищаем все overlay при первом game_state (первый кадр)
        const countdownOverlay = document.getElementById('countdown-overlay');
        if (countdownOverlay) {
          countdownOverlay.style.display = 'none';
          countdownOverlay.classList.remove('active');
        }
        const lobbyScreen = document.getElementById('lobby-screen');
        if (lobbyScreen) {
          lobbyScreen.classList.remove('active');
          lobbyScreen.style.display = 'none';
        }
        console.log('✅ Overlay и lobby очищены при первом game_state');
      }
      updateGameState(data);
    } else {
      console.warn('⚠️ game_state received but gameState is:', gameState, 'currentGame:', currentGame);
    }
  });
  
  socket.on('game_end', (data) => {
    console.log('📨 Событие game_end получено!', data);
    
    // ОПТИМИЗАЦИЯ: Получаем финальный JSON с результатом и только тогда обновляем баланс из БД
    // Сначала обрабатываем финальное состояние игры
    endGame(data);
    
    // Затем запрашиваем актуальный баланс из БД (если есть выигрыш)
    if (data.prize && data.prize > 0) {
      // Запрашиваем актуальный баланс из БД через API
      fetch(`/api/user/${userId}`)
        .then(response => response.json())
        .then(userData => {
          // Обновляем баланс из БД только после получения финального результата
          updateBalance(userData.games_balance, userData.winnings_ton);
          console.log('💰 Balance updated from DB after game completion:', userData);
        })
        .catch(error => {
          console.error('❌ Ошибка при получении баланса из БД:', error);
          // Fallback: используем данные из game_end события
          if (data.winnings_ton !== undefined) {
            updateBalance(data.games_balance || 0, data.winnings_ton);
          }
        });
    }
  });
  
  // Обновление баланса после начисления выигрыша
  socket.on('balance_updated', (data) => {
    console.log('💰 Balance updated:', data);
    
    // ОПТИМИЗАЦИЯ: Если есть флаг rollback, откатываем оптимистичное обновление
    if (data.rollback) {
      console.warn('⚠️ Откат оптимистичного обновления баланса');
    }
    
    updateBalance(data.games_balance, data.winnings_ton);
  });
  
  // ОПТИМИЗАЦИЯ: Обработчик обновления баланса игр
  socket.on('games_balance_updated', (data) => {
    console.log('💰 Баланс игр обновлен:', data);
    refreshUserProfile();
  });
  
  // ОПТИМИЗАЦИЯ: Обработчик подтверждения покупки игр (финальное состояние из БД)
  socket.on('buy_games_confirmed', (data) => {
    console.log('✅ Game purchase confirmed (DB updated):', data);
    // Обновляем баланс финальными данными из БД
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
    
    // Скрываем статус polling
    const pollingStatusEl = document.getElementById('polling-status');
    if (pollingStatusEl) {
      pollingStatusEl.style.display = 'none';
      pollingStatusEl.textContent = '';
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
      ? `✅ Money sent! ${data.amount} TON sent to your wallet. TX: ${data.txHash.substring(0, 10)}...`
      : `✅ Money sent! ${data.amount} TON sent to your wallet.`;
      
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
    const errorMessage = error.message || 'Unknown error';
    const message = `❌ Error: ${errorMessage}. Check your wallet or balance.`;
    
    if (window.Telegram && window.Telegram.WebApp) {
      window.Telegram.WebApp.showAlert(message);
    } else {
      alert(message);
    }
  });
  
  // Обработчик успешной покупки игр с выигрышного баланса (оптимистичное обновление)
  socket.on('buy_games_success', (data) => {
    console.log('✅ Games purchased with winnings (optimistic update):', data);
    
    // ИСПРАВЛЕНИЕ: Мгновенно обновляем локальную переменную user.games_balance
    if (data.games_purchased !== undefined) {
      localUserState.games_balance = data.games_balance || (localUserState.games_balance + data.games_purchased);
    }
    if (data.winnings_ton !== undefined) {
      localUserState.winnings_ton = data.winnings_ton;
    }
    
    // ОПТИМИЗАЦИЯ: Мгновенно обновляем баланс в UI
    updateBalance(localUserState.games_balance, localUserState.winnings_ton);
    
    // ИСПРАВЛЕНИЕ: Принудительно обновляем элемент #balance-value
    const balanceValueEl = document.getElementById('balance-value');
    if (balanceValueEl) {
      balanceValueEl.textContent = localUserState.games_balance || 0;
    }
    
    // STATE MANAGEMENT: Обновляем appState перед обновлением UI
    if (data.games_balance !== undefined) {
      window.appState.user.games_balance = data.games_balance;
    }
    if (data.winnings_ton !== undefined) {
      window.appState.user.winnings_ton = data.winnings_ton;
    }
    
    // ЛОГИКА ПОКУПКИ: Вызываем updateBalance для мгновенного обновления всех элементов интерфейса
    updateBalance(localUserState.games_balance, localUserState.winnings_ton);
    
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
    
    tg.showAlert(`✅ Purchased ${data.games_purchased} games for ${data.games_purchased} TON winnings!`);
  });
  
  // Дополнительный обработчик для buy_success (на случай если сервер отправляет это событие)
  socket.on('buy_success', (data) => {
    console.log('✅ Purchase successful (buy_success):', data);
    
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
  
  // ОПТИМИЗАЦИЯ: Обработчик подтверждения покупки игр (финальное состояние из БД)
  socket.on('buy_games_confirmed', (data) => {
    console.log('✅ Game purchase confirmed (DB updated):', data);
    // Обновляем баланс финальными данными из БД
    updateBalance(data.games_balance, data.winnings_ton);
  });
  
  // ОПТИМИЗАЦИЯ: Обработчик ошибки покупки с откатом оптимистичного обновления
  socket.on('buy_games_error', (data) => {
    console.error('❌ Ошибка покупки игр:', data);
    
    // Если есть флаг rollback, откатываем оптимистичное обновление
    if (data.rollback && data.games_balance !== undefined && data.winnings_ton !== undefined) {
      console.warn('⚠️ Откат оптимистичного обновления баланса');
      updateBalance(data.games_balance, data.winnings_ton);
    }
    
    // Восстанавливаем кнопку
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
    
    tg.showAlert(data.message || '❌ Error purchasing games');
  });
  
  // Обработчик ошибки покупки игр с выигрышного баланса
  socket.on('buy_games_error', (data) => {
    const errorMessage = data.message || 'Error purchasing games';
    
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
    // ОПТИМИЗАЦИЯ: Обновляем баланс после закрытия модального окна вывода
    // (refreshUserProfile вызывается внутри toggleModal, но можно добавить дополнительный вызов)
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
      
      // STATE MANAGEMENT: Обновление баланса после транзакции
      // Если транзакция инициирована, при закрытии модального окна через 3-5 секунд
      // принудительно запрашиваем /api/user/profile для обновления баланса игр
      let paymentInitiated = false;
      
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
        paymentInitiated = true; // Транзакция инициирована
        
        // Удаляем ссылку после клика
        setTimeout(() => {
          document.body.removeChild(link);
        }, 100);
        
        // ЛОГИКА ОПЛАТЫ: Добавляем визуальный индикатор «Ожидание оплаты...»
        const statusEl = document.getElementById('payment-status');
        if (statusEl) {
          statusEl.textContent = '⏳ Waiting for payment...';
          statusEl.style.color = '#667eea';
        }
        
        // ВИЗУАЛИЗАЦИЯ ПОЛЛИНГА: Показываем статус polling
        const pollingStatusEl = document.getElementById('polling-status');
        if (pollingStatusEl) {
          pollingStatusEl.style.display = 'block';
          pollingStatusEl.textContent = '⏳ Waiting for transaction confirmation in blockchain... (usually 15-30 sec)';
        }
        
        // ЛОГИКА ОПЛАТЫ: Периодический запрос баланса (polling) к серверу
        // чтобы приложение автоматически закрыло модалку, когда баланс изменится
        if (paymentInitiated) {
          const initialBalance = localUserState.games_balance || 0;
          let pollCount = 0;
          const maxPolls = 30; // Максимум 30 попыток (5 минут)
          
          const pollBalance = setInterval(async () => {
            pollCount++;
            console.log(`🔄 Polling balance (attempt ${pollCount}/${maxPolls})...`);
            
            try {
              await refreshUserProfile();
              const currentBalance = localUserState.games_balance || 0;
              
              // Если баланс изменился, закрываем модалку
              if (currentBalance > initialBalance) {
                console.log('✅ Balance updated! Closing payment modal.');
                clearInterval(pollBalance);
                
                // Скрываем статус polling
                if (pollingStatusEl) {
                  pollingStatusEl.style.display = 'none';
                }
                
                toggleModal('payment-modal', false);
                
                if (statusEl) {
                  statusEl.textContent = '✅ Payment received!';
                  statusEl.style.color = '#00ff41';
                  setTimeout(() => {
                    statusEl.textContent = '';
                  }, 2000);
                }
              } else if (pollCount >= maxPolls) {
                // Прекращаем polling после максимального количества попыток
                clearInterval(pollBalance);
                console.log('⏱️ Polling completed (attempt limit reached)');
                if (pollingStatusEl) {
                  pollingStatusEl.style.display = 'none';
                }
              }
            } catch (error) {
              console.error('❌ Error polling balance:', error);
              if (pollCount >= maxPolls) {
                clearInterval(pollBalance);
                if (pollingStatusEl) {
                  pollingStatusEl.style.display = 'none';
                }
              }
            }
          }, 10000); // Каждые 10 секунд
          
          // Очищаем polling при закрытии модалки
          const paymentModal = document.getElementById('payment-modal');
          if (paymentModal) {
            const observer = new MutationObserver((mutations) => {
              mutations.forEach((mutation) => {
                if (!paymentModal.classList.contains('modal-visible')) {
                  clearInterval(pollBalance);
                  if (pollingStatusEl) {
                    pollingStatusEl.style.display = 'none';
                  }
                  observer.disconnect();
                }
              });
            });
            observer.observe(paymentModal, { attributes: true, attributeFilter: ['class'] });
          }
        }
      } catch (linkError) {
        // Если клик не сработал, пробуем tg.openLink()
        console.warn('Link click failed, trying tg.openLink():', linkError);
        document.body.removeChild(link);
        
        if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.openLink) {
          try {
            window.Telegram.WebApp.openLink(tonkeeperUrl, { try_instant_view: false });
            console.log('Opened Tonkeeper via tg.openLink()');
            paymentInitiated = true; // Транзакция инициирована
            
            const statusEl = document.getElementById('payment-status');
            if (statusEl) {
              statusEl.textContent = '⏳ Waiting for payment...';
              statusEl.style.color = '#667eea';
            }
            
            // STATE MANAGEMENT: Обновление баланса через 3-5 секунд после инициирования транзакции
            if (paymentInitiated) {
              setTimeout(() => {
                console.log('🔄 Updating balance after transaction...');
                refreshUserProfile();
              }, 4000); // 4 секунды для обработки транзакции
            }
          } catch (tgError) {
            // Если tg.openLink() тоже не сработал, пробуем window.location
            console.warn('tg.openLink() failed, trying window.location:', tgError);
            try {
              window.location.href = tonkeeperUrl;
              paymentInitiated = true; // Транзакция инициирована
              const statusEl = document.getElementById('payment-status');
              if (statusEl) {
                statusEl.textContent = '⏳ Waiting for payment...';
                statusEl.style.color = '#667eea';
              }
              
              // STATE MANAGEMENT: Обновление баланса через 3-5 секунд после инициирования транзакции
              if (paymentInitiated) {
                setTimeout(() => {
                  console.log('🔄 Updating balance after transaction...');
                  refreshUserProfile();
                }, 4000); // 4 секунды для обработки транзакции
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
            paymentInitiated = true; // Транзакция инициирована
            const statusEl = document.getElementById('payment-status');
            if (statusEl) {
              statusEl.textContent = '⏳ Waiting for payment...';
              statusEl.style.color = '#667eea';
            }
            
            // STATE MANAGEMENT: Обновление баланса через 3-5 секунд после инициирования транзакции
            if (paymentInitiated) {
              setTimeout(() => {
                console.log('🔄 Updating balance after transaction...');
                refreshUserProfile();
              }, 4000); // 4 секунды для обработки транзакции
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
    // STATE MANAGEMENT: Обновляем баланс после закрытия модального окна оплаты
    // Запрашиваем профиль через 3-5 секунд для обновления баланса после транзакции
    setTimeout(() => {
      refreshUserProfile();
    }, 3500); // 3.5 секунды для обработки транзакции
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
 * СИНГЛТОН CANVAS: создается ОДИН РАЗ при загрузке экрана game и не пересоздается
 */
function initCanvas() {
  // Если Canvas уже инициализирован, не пересоздаем его
  if (canvasInitialized && gameCanvas && gameCtx) {
    console.log('✅ Canvas уже инициализирован, пропускаем повторную инициализацию');
    return;
  }
  
  // CANVAS CLEANUP: Удаляем все существующие canvas элементы в контейнере игры
  // только если Canvas еще не инициализирован
  if (!canvasInitialized) {
    const gameScreen = document.getElementById('game-screen');
    if (gameScreen) {
      const existingCanvases = gameScreen.querySelectorAll('canvas');
      existingCanvases.forEach(canvas => {
        // Останавливаем render loop если он запущен
        if (animationFrameId) {
          cancelAnimationFrame(animationFrameId);
          animationFrameId = null;
        }
        canvas.remove();
      });
    }
  }
  
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
  
  // ГАРАНТИРОВАННЫЙ CANVAS: если элемента canvas нет, создаем его программно
  let canvas = document.getElementById('game-canvas');
  if (!canvas) {
    // Ищем контейнер (game-container внутри game-screen или game-canvas-container)
    const gameContainer = document.querySelector('#game-screen .game-container') || 
                          document.getElementById('game-canvas-container') ||
                          document.getElementById('game-screen');
    if (!gameContainer) {
      console.error('❌ Контейнер для canvas не найден!');
      return;
    }
    
    canvas = document.createElement('canvas');
    canvas.id = 'game-canvas';
    gameContainer.appendChild(canvas);
    console.log('✅ Canvas создан программно в контейнере (ОДИН РАЗ)');
  }
  
  // СВЯЗЬ ctx С РЕНДЕРОМ: обновляем глобальные переменные
  gameCanvas = canvas;
  
  // Убеждаемся, что canvas имеет правильные стили позиционирования
  // Изменено на relative для правильного центрирования через CSS (width: 95vw)
  if (gameCanvas.style.position !== 'relative') {
    gameCanvas.style.position = 'relative';
  }
  
  // ИСПРАВЛЕНИЕ: Используем { alpha: false } для оптимизации контекста 2D
  gameCtx = gameCanvas.getContext('2d', { alpha: false });
  
  if (!gameCtx) {
    console.error('❌ Не удалось получить контекст 2D для canvas');
    return;
  }
  
  // Отключаем сглаживание изображений для четкости и устранения микро-размытия при движении
  gameCtx.imageSmoothingEnabled = false;
  
  // ОПТИМИЗАЦИЯ: Canvas занимает 100% ширины родительского контейнера, высота подстраивается под ширину
  // Это обеспечивает максимально крупное поле на экране телефона
  const containerWidth = gameCanvas.parentElement?.clientWidth || window.innerWidth;
  const containerHeight = window.innerHeight;
  
  // Используем 98% ширины контейнера (с небольшим отступом для визуального комфорта)
  const cssWidth = containerWidth * 0.98;
  // Высота подстраивается под ширину для квадрата (1:1), но ограничиваем высотой экрана
  const cssHeight = Math.min(cssWidth, containerHeight * 0.95);
  
  // ИСПРАВЛЕНИЕ: Логический размер Canvas (для отрисовки) - четкий размер
  canvasLogicalSize = Math.floor(cssHeight);
  
  // ИСПРАВЛЕНИЕ: tileSize рассчитывается как logicalSize / 30
  const tileSize = canvasLogicalSize / GRID_SIZE;
  window.tileSize = tileSize; // Сохраняем для использования в других функциях
  
  // ОПТИМИЗАЦИЯ: Устанавливаем CSS размеры для адаптивности
  gameCanvas.style.width = '98%'; // 98% ширины контейнера
  gameCanvas.style.height = 'auto'; // Высота подстраивается автоматически
  gameCanvas.style.aspectRatio = '1 / 1'; // Сохраняем квадратную форму
  gameCanvas.style.maxWidth = '100%';
  gameCanvas.style.maxHeight = '95vh'; // Ограничиваем высотой экрана
  
  // УПРАВЛЕНИЕ DPR: вызываем scale только один раз при инициализации
  canvasDPR = window.devicePixelRatio || 1;
  
  // Устанавливаем физический размер с учетом DPR для четкости
  gameCanvas.width = canvasLogicalSize * canvasDPR;
  gameCanvas.height = canvasLogicalSize * canvasDPR;
  
  // ИСПРАВЛЕНИЕ: Установи gameCtx.setTransform(canvasDPR, 0, 0, canvasDPR, 0, 0) один раз при инициализации
  gameCtx.setTransform(canvasDPR, 0, 0, canvasDPR, 0, 0);
  
  // CSS размер (для отображения на экране) - устанавливается через CSS (95vw)
  // Не устанавливаем здесь, чтобы CSS мог управлять размером
  
  // Помечаем Canvas как инициализированный
  canvasInitialized = true;
  
  console.log(`🎨 Canvas инициализирован ОДИН РАЗ: логический размер=${canvasLogicalSize}px, DPR=${canvasDPR}, физический=${gameCanvas.width}x${gameCanvas.height}`);
  
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
  
  // УБРАТЬ ПЕРЕКРЫТИЕ ЭКРАНОВ: В функции showScreen('game') добавляем команды для скрытия lobby-screen
  if (screenName === 'game') {
    const gameScreen = document.getElementById('game-screen');
    const lobbyScreen = document.getElementById('lobby-screen');
    const gameCanvas = document.getElementById('game-canvas');
    
    if (gameScreen) {
      gameScreen.style.zIndex = '100';
      gameScreen.style.display = 'flex';
    }
    
    // УБРАТЬ ПЕРЕКРЫТИЕ ЭКРАНОВ: document.getElementById('lobby-screen').classList.remove('active'); document.getElementById('lobby-screen').style.display = 'none';
    if (lobbyScreen) {
      lobbyScreen.classList.remove('active');
      lobbyScreen.style.display = 'none';
      console.log('✅ lobby-screen скрыт при переключении на game');
    }
    
    // СДЕЛАТЬ ОТСЧЕТ ВИДИМЫМ: Подними Canvas на передний план: canvas.style.position = 'relative'; canvas.style.zIndex = '1000';
    if (gameCanvas) {
      gameCanvas.style.position = 'relative';
      gameCanvas.style.zIndex = '1000';
    }
  }
  
  // Останавливаем цикл отрисовки если переключаемся с игрового экрана
  if (gameState === 'playing' && screenName !== 'playing') {
    stopRenderLoop();
  }
  
  // СИНГЛТОН CANVAS: инициализируем Canvas только один раз при первом показе экрана game
  if (screenName === 'game' && !canvasInitialized) {
    // ИСПРАВЛЕНИЕ ТАЙМИНГА: используем requestAnimationFrame для гарантированного обновления DOM
    requestAnimationFrame(() => {
      initCanvas(); // Вызываем только если Canvas еще не инициализирован
      // ПРОВЕРКА КОНТЕКСТА: убеждаемся, что ctx обновляется
      if (gameCanvas && gameCtx) {
        console.log('✅ Canvas инициализирован в showScreen (ОДИН РАЗ), ctx создан');
      } else {
        console.error('❌ Canvas или ctx не созданы в showScreen!');
      }
    });
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
      window.Telegram.WebApp.showAlert('Error: no connection to server');
    } else {
      alert('Error: no connection to server');
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
    tg.showAlert(`❌ Insufficient winnings! Available: ${currentWinnings.toFixed(2)} TON, required: ${amount} TON`);
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
    tg.showAlert('❌ No connection to server. Please refresh the page.');
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
// ОПТИМИЗАЦИЯ: Локальный объект пользователя для моментального обновления баланса
let localUserState = {
  games_balance: 0,
  winnings_ton: 0
};

/**
 * ОПТИМИЗАЦИЯ: Обновление профиля пользователя с сервера
 * Запрашивает актуальный баланс и синхронизирует его с UI
 */
async function refreshUserProfile() {
  if (!userId) {
    console.warn('⚠️ refreshUserProfile: userId не установлен');
    return;
  }
  
  try {
    const response = await fetch(`/api/user/${userId}`);
    if (!response.ok) {
      console.error(`❌ Ошибка получения профиля: ${response.status}`);
      return;
    }
    
    const userData = await response.json();
    
    // STATE MANAGEMENT: Обновляем window.appState перед обновлением UI
    window.appState.user.games_balance = userData.games_balance || 0;
    window.appState.user.winnings_ton = userData.winnings_ton || 0;
    window.appState.user.id = userData.id || userId;
    window.appState.user.username = userData.username || username;
    
    // Синхронизируем локальный стейт с данными сервера
    localUserState.games_balance = userData.games_balance || 0;
    localUserState.winnings_ton = userData.winnings_ton || 0;
    
    // Обновляем UI
    updateBalance(localUserState.games_balance, localUserState.winnings_ton);
    
    console.log(`✅ Профиль обновлен: игры=${localUserState.games_balance}, выигрыши=${localUserState.winnings_ton.toFixed(2)} TON`);
  } catch (error) {
    console.error('❌ Ошибка при обновлении профиля:', error);
  }
}

function updateBalance(gamesBalance, winningsTon) {
  // STATE MANAGEMENT: Обновляем window.appState перед обновлением UI
  if (gamesBalance !== undefined) {
    window.appState.user.games_balance = gamesBalance;
    localUserState.games_balance = gamesBalance;
  }
  if (winningsTon !== undefined) {
    window.appState.user.winnings_ton = winningsTon;
    localUserState.winnings_ton = winningsTon;
  }
  
  const gamesEl = document.getElementById('games-balance');
  const winningsEl = document.getElementById('winnings-balance');
  const balanceValueEl = document.getElementById('balance-value');
  
  // ИСПРАВЛЕНИЕ: Обновляем элемент #balance-value если он существует
  if (balanceValueEl) {
    balanceValueEl.textContent = window.appState.user.games_balance || 0;
  }
  
  // ОПТИМИЗАЦИЯ: Мгновенно обновляем UI без ожидания перезагрузки страницы
  if (gamesEl) {
    gamesEl.textContent = localUserState.games_balance || 0;
    // Добавляем визуальную анимацию обновления для обратной связи
    gamesEl.style.transition = 'transform 0.2s ease';
    gamesEl.style.transform = 'scale(1.1)';
    setTimeout(() => {
      if (gamesEl) gamesEl.style.transform = 'scale(1)';
    }, 200);
  }
  if (winningsEl) {
    winningsEl.textContent = `${(localUserState.winnings_ton || 0).toFixed(2)} TON`;
    // Добавляем визуальную анимацию обновления для обратной связи
    winningsEl.style.transition = 'transform 0.2s ease';
    winningsEl.style.transform = 'scale(1.1)';
    setTimeout(() => {
      if (winningsEl) winningsEl.style.transform = 'scale(1)';
    }, 200);
  }
  
  // ИСПРАВЛЕНИЕ: Обновляем элемент #balance-value если он существует
  if (balanceValueEl) {
    balanceValueEl.textContent = localUserState.games_balance || 0;
  }
  
  // Показываем/скрываем кнопку покупки игр с выигрышного баланса
  const buyWithWinningsBtn = document.getElementById('buy-games-with-winnings-btn');
  if (buyWithWinningsBtn) {
    const hasWinnings = localUserState.winnings_ton && localUserState.winnings_ton >= 1;
    buyWithWinningsBtn.style.display = hasWinnings ? 'block' : 'none';
  }
  
  console.log(`💰 Balance updated instantly: games=${localUserState.games_balance}, winnings=${localUserState.winnings_ton.toFixed(2)} TON`);
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
      tg.showAlert(`✅ Balance topped up with ${amount} games`);
    } else {
      tg.showAlert(`❌ Ошибка: ${data.error}`);
    }
  } catch (error) {
    console.error('Ошибка пополнения баланса:', error);
    tg.showAlert('Error topping up balance');
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
  
  // СИНГЛТОН CANVAS: инициализируем Canvas только если он еще не инициализирован
  if (!canvasInitialized) {
    initCanvas();
  }
  
  // ПРОВЕРКА КОНТЕКСТА: убеждаемся, что ctx доступен
  if (!gameCanvas || !gameCtx) {
    console.error('❌ Canvas или ctx не инициализированы!');
    return;
  }
  
  // Запускаем цикл отрисовки
  if (!animationFrameId) {
    startRenderLoop();
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
 * Валидация координат змейки: проверка, что координаты в пределах поля 0-29
 * ЛОГИКА ГРАНИЦ: если игра завершена (finished: true), разрешаем невалидные координаты для отрисовки последнего кадра
 */
function validateSnakeCoordinates(snake, snakeName = 'snake', allowInvalidOnFinish = false) {
  // ИСПРАВЛЕНИЕ ДОСТУПА К КООРДИНАТАМ: Используем segments вместо body
  const segments = snake?.segments || snake?.body;
  if (!snake || !segments) return false;
  
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.x < 0 || segment.x >= GRID_SIZE || segment.y < 0 || segment.y >= GRID_SIZE) {
      if (allowInvalidOnFinish) {
        // Если игра завершена, логируем но разрешаем отрисовку для показа последнего кадра
        console.warn(`⚠️ ${snakeName} out of bounds at segment ${i}: x=${segment.x}, y=${segment.y} (game finished, allowing render)`);
        // ЛОГИРОВАНИЕ НАПРАВЛЕНИЯ: логируем направление перед смертью
        if (i === 0 && snake.direction) {
          console.log(`📊 ${snakeName} direction before death: dx=${snake.direction.dx}, dy=${snake.direction.dy}`);
        }
        return true; // Разрешаем отрисовку при завершении игры
      } else {
        console.error(`❌ Error: Invalid ${snakeName} position at segment ${i}: x=${segment.x}, y=${segment.y} (must be 0-${GRID_SIZE-1})`);
        return false;
      }
    }
  }
  return true;
}

/**
 * Быстрая функция клонирования только нужных полей (оптимизация производительности)
 * С ВАЛИДАЦИЕЙ КООРДИНАТ: проверяем, что координаты в пределах поля 0-29
 * ИСПРАВЛЕНИЕ: при finished: true разрешаем невалидные координаты для отрисовки последнего кадра
 */
function cloneSnakeState(data) {
  if (!data) return null;
  
  // Проверяем, завершена ли игра
  const isFinished = data.finished === true || data.game_finished === true;
  
  const cloned = {
    tick_number: data.tick_number || 0, // Сохраняем номер тика для отслеживания пропусков
    finished: isFinished, // Сохраняем флаг завершения игры
    my_snake: null,
    opponent_snake: null
  };
  
  // ИСПРАВЛЕНИЕ ДОСТУПА К КООРДИНАТАМ: Используем segments вместо body
  // Клонируем и валидируем мою змейку
  if (data.my_snake) {
    const segments = (data.my_snake.segments || data.my_snake.body || []).map(s => ({ x: s.x, y: s.y }));
    cloned.my_snake = {
      segments: segments,
      direction: { dx: data.my_snake.direction.dx, dy: data.my_snake.direction.dy },
      alive: data.my_snake.alive
    };
    
    // ВАЛИДАЦИЯ: если игра завершена, разрешаем невалидные координаты
    if (!validateSnakeCoordinates(cloned.my_snake, 'my_snake', isFinished)) {
      if (!isFinished) {
        console.error('❌ Invalid my_snake coordinates, rejecting state');
        return null; // Отклоняем невалидное состояние только если игра не завершена
      }
    }
  }
  
  // Клонируем и валидируем змейку противника
  if (data.opponent_snake) {
    const segments = (data.opponent_snake.segments || data.opponent_snake.body || []).map(s => ({ x: s.x, y: s.y }));
    cloned.opponent_snake = {
      segments: segments,
      direction: { dx: data.opponent_snake.direction.dx, dy: data.opponent_snake.direction.dy },
      alive: data.opponent_snake.alive
    };
    
    // ВАЛИДАЦИЯ: если игра завершена, разрешаем невалидные координаты
    if (!validateSnakeCoordinates(cloned.opponent_snake, 'opponent_snake', isFinished)) {
      if (!isFinished) {
        console.error('❌ Invalid opponent_snake coordinates, rejecting state');
        return null; // Отклоняем невалидное состояние только если игра не завершена
      }
    }
    
    // ЛОГИРОВАНИЕ НАПРАВЛЕНИЯ ПЕРЕД СМЕРТЬЮ: если координаты невалидны и игра завершена
    // ИСПРАВЛЕНИЕ ДОСТУПА К КООРДИНАТАМ: Используем segments вместо body
    const opponentSegments = cloned.opponent_snake?.segments || cloned.opponent_snake?.body;
    if (isFinished && opponentSegments && opponentSegments[0]) {
      const head = opponentSegments[0];
      if (head.x < 0 || head.x >= GRID_SIZE || head.y < 0 || head.y >= GRID_SIZE) {
        console.log(`📊 opponent_snake direction before death: dx=${cloned.opponent_snake.direction.dx}, dy=${cloned.opponent_snake.direction.dy}`);
        console.log(`📊 opponent_snake final position: x=${head.x}, y=${head.y}, alive=${cloned.opponent_snake.alive}`);
      }
    }
  }
  
  return cloned;
}

/**
 * Обновление состояния игры - адаптивная синхронизация с экспоненциальным сглаживанием (EMA)
 * Использует быстрое клонирование вместо JSON.parse/stringify
 * Виртуальное время мягко следует за реальным, убирая эффект "гармошки"
 */
/**
 * STABLE PLAYBACK QUEUE: простая очередь пакетов
 * При получении game_state просто добавляем в очередь
 * С ВАЛИДАЦИЕЙ КООРДИНАТ: проверяем координаты перед добавлением в очередь
 */
function updateGameState(data) {
  // ВАЛИДАЦИЯ: проверяем координаты перед добавлением в очередь
  if (!data) {
    console.error('❌ updateGameState: data is null');
    return;
  }
  
  // Проверяем, завершена ли игра
  const isFinished = data.finished === true || data.game_finished === true;
  
  // УПРОЩЕННАЯ НОРМАЛИЗАЦИЯ: При получении пакета сразу создаем объект, где координаты лежат в segments
  // Нормализуем данные: если сервер прислал body, преобразуем в segments
  const normalizedData = {
    ...data,
    my_snake: data.my_snake ? {
      ...data.my_snake,
      segments: data.my_snake.segments || data.my_snake.body || []
    } : null,
    opponent_snake: data.opponent_snake ? {
      ...data.opponent_snake,
      segments: data.opponent_snake.segments || data.opponent_snake.body || []
    } : null
  };
  
  // Клонируем и валидируем состояние
  const cloned = cloneSnakeState(normalizedData);
  if (!cloned) {
    // ИСПРАВЛЕНИЕ: если игра завершена, все равно добавляем состояние для отрисовки последнего кадра
    if (isFinished) {
      // Создаем минимальное состояние для отрисовки
      const fallbackState = {
        tick_number: normalizedData.tick_number || 0,
        finished: true,
        my_snake: normalizedData.my_snake ? {
          segments: (normalizedData.my_snake.segments || normalizedData.my_snake.body || []).map(s => ({ x: s.x, y: s.y })),
          direction: normalizedData.my_snake.direction ? { dx: normalizedData.my_snake.direction.dx, dy: normalizedData.my_snake.direction.dy } : { dx: 1, dy: 0 },
          alive: normalizedData.my_snake.alive
        } : null,
        opponent_snake: normalizedData.opponent_snake ? {
          segments: (normalizedData.opponent_snake.segments || normalizedData.opponent_snake.body || []).map(s => ({ x: s.x, y: s.y })),
          direction: normalizedData.opponent_snake.direction ? { dx: normalizedData.opponent_snake.direction.dx, dy: normalizedData.opponent_snake.direction.dy } : { dx: -1, dy: 0 },
          alive: normalizedData.opponent_snake.alive
        } : null
      };
      packetQueue.push(fallbackState);
      return;
    } else {
      return; // Не добавляем невалидное состояние в очередь
    }
  }
  
  // ГАРАНТИРУЕМ НАЛИЧИЕ SEGMENTS: Убедись, что cloned.my_snake.segments ВСЕГДА существует перед пушем в packetQueue
  if (cloned.my_snake && !cloned.my_snake.segments) {
    cloned.my_snake.segments = cloned.my_snake.body || [];
  }
  if (cloned.opponent_snake && !cloned.opponent_snake.segments) {
    cloned.opponent_snake.segments = cloned.opponent_snake.body || [];
  }
  
  // Логируем координаты для диагностики
  // ИСПРАВЛЕНИЕ ДОСТУПА К КООРДИНАТАМ: Используем segments вместо body
  const mySnakeSegments = cloned.my_snake?.segments || cloned.my_snake?.body;
  if (mySnakeSegments && mySnakeSegments[0]) {
    const head = mySnakeSegments[0];
    if (head.x < 0 || head.x >= GRID_SIZE || head.y < 0 || head.y >= GRID_SIZE) {
      if (isFinished) {
        console.warn(`⚠️ my_snake head out of bounds (game finished): x=${head.x}, y=${head.y}, tick=${cloned.tick_number}`);
        // ЛОГИРОВАНИЕ НАПРАВЛЕНИЯ ПЕРЕД СМЕРТЬЮ
        if (cloned.my_snake.direction) {
          console.log(`📊 my_snake direction before death: dx=${cloned.my_snake.direction.dx}, dy=${cloned.my_snake.direction.dy}`);
        }
      } else {
        console.error(`❌ CRITICAL: my_snake head out of bounds: x=${head.x}, y=${head.y}, tick=${cloned.tick_number}`);
      }
    }
  }
  const opponentSnakeSegments = cloned.opponent_snake?.segments || cloned.opponent_snake?.body;
  if (opponentSnakeSegments && opponentSnakeSegments[0]) {
    const head = opponentSnakeSegments[0];
    if (head.x < 0 || head.x >= GRID_SIZE || head.y < 0 || head.y >= GRID_SIZE) {
      if (isFinished) {
        console.warn(`⚠️ opponent_snake head out of bounds (game finished): x=${head.x}, y=${head.y}, tick=${cloned.tick_number}`);
        // ЛОГИРОВАНИЕ НАПРАВЛЕНИЯ ПЕРЕД СМЕРТЬЮ
        if (cloned.opponent_snake.direction) {
          console.log(`📊 opponent_snake direction before death: dx=${cloned.opponent_snake.direction.dx}, dy=${cloned.opponent_snake.direction.dy}`);
        }
      } else {
        console.error(`❌ CRITICAL: opponent_snake head out of bounds: x=${head.x}, y=${head.y}, tick=${cloned.tick_number}`);
      }
    }
  }
  
  // Добавляем валидный пакет в очередь
  packetQueue.push(cloned);
  
  // Запускаем цикл отрисовки если он еще не запущен
  if (!animationFrameId && gameState === 'playing') {
    startRenderLoop();
  }
}

// STABLE PLAYBACK QUEUE: простой цикл отрисовки с фиксированным шагом
function startRenderLoop() {
  if (animationFrameId) cancelAnimationFrame(animationFrameId);
  isRendering = true;

  if (!gridCanvas) {
    gridCanvas = document.createElement('canvas');
    gridCanvas.width = canvasLogicalSize;
    gridCanvas.height = canvasLogicalSize;
    gridCtx = gridCanvas.getContext('2d');
    drawGridToOffscreen(); // Убедись, что эта функция использует gridCtx
  }

  function render(now) {
    // ИСПРАВЛЕНИЕ: Рендер должен работать ВСЕГДА, пока открыт экран игры
    // Убрана блокировка цикла по gameState
    if (!isRendering || !gameCtx) {
      animationFrameId = requestAnimationFrame(render);
      return;
    }

    // 1. Очистка и фон
    gameCtx.fillStyle = '#0a0e27';
    gameCtx.fillRect(0, 0, canvasLogicalSize, canvasLogicalSize);

    // 2. Сетка
    if (gridCanvas) gameCtx.drawImage(gridCanvas, 0, 0);

    // ИСПРАВЛЕНИЕ: Раздели логику - пакеты из packetQueue только обновляют window.appState.game
    // Обрабатываем очередь пакетов (только обновление состояния)
    while (packetQueue.length > 0) {
      const nextPacket = packetQueue.shift();
      if (!nextPacket) continue;

      // Сохраняем предыдущее состояние для интерполяции
      if (interpolatedGameState) {
        previousGameState = JSON.parse(JSON.stringify(interpolatedGameState));
      }

      // Синхронизируем состояние из пакета
      const newState = {
        my_snake: nextPacket.my_snake ? {
          segments: nextPacket.my_snake.segments || nextPacket.my_snake.body || [],
          direction: nextPacket.my_snake.direction || { dx: 1, dy: 0 },
          alive: nextPacket.my_snake.alive !== undefined ? nextPacket.my_snake.alive : true
        } : null,
        opponent_snake: nextPacket.opponent_snake ? {
          segments: nextPacket.opponent_snake.segments || nextPacket.opponent_snake.body || [],
          direction: nextPacket.opponent_snake.direction || { dx: -1, dy: 0 },
          alive: nextPacket.opponent_snake.alive !== undefined ? nextPacket.opponent_snake.alive : true
        } : null,
        tick_number: nextPacket.tick_number || 0,
        finished: nextPacket.finished === true || nextPacket.game_finished === true
      };

      // Обновляем window.appState.game
      window.appState.game.my_snake = newState.my_snake;
      window.appState.game.opponent_snake = newState.opponent_snake;
      window.appState.game.tick_number = newState.tick_number;
      window.appState.game.finished = newState.finished;

      // Сохраняем текущее состояние для интерполяции
      interpolatedGameState = newState;
      lastStateUpdateTime = now;
    }

    // ИСПРАВЛЕНИЕ: Отрисовка змеек должна идти ВСЕГДА на основе данных из window.appState.game
    // (даже если новых пакетов нет) - это уберет мерцание и исчезновение змеек
    
    // 3. ОТРИСОВКА ОТСЧЕТА (COUNTDOWN): Рисуем ОТСЧЕТ ПЕРЕД отрисовкой змеек
    // Проверяем несколько источников для получения значения отсчета
    if (gameState === 'countdown' || window.appState?.game?.status === 'countdown') {
      const countdownNumber = document.getElementById('countdown-number');
      const countdownVal = window.appState?.game?.countdownValue || 
                          countdownNumber?.textContent || 
                          countdownValue || 
                          "";
      
      if (countdownVal) {
        gameCtx.save();
        // Делаем отсчет очень заметным
        gameCtx.font = "bold 120px Inter, Arial, sans-serif";
        gameCtx.fillStyle = "#ffffff";
        gameCtx.textAlign = "center";
        gameCtx.textBaseline = "middle";
        gameCtx.shadowBlur = 30;
        gameCtx.shadowColor = "#00f5ff";
        gameCtx.shadowOffsetX = 0;
        gameCtx.shadowOffsetY = 0;
        // Рисуем текст с обводкой для лучшей видимости
        gameCtx.strokeStyle = "#00f5ff";
        gameCtx.lineWidth = 4;
        gameCtx.strokeText(countdownVal, canvasLogicalSize / 2, canvasLogicalSize / 2);
        gameCtx.fillText(countdownVal, canvasLogicalSize / 2, canvasLogicalSize / 2);
        gameCtx.restore();
      }
    }
    
    // 4. ИНТЕРПОЛЯЦИЯ: Вычисляем интерполированное состояние для плавного движения
    let interpolatedMySnake = null;
    let interpolatedOppSnake = null;
    
    if (interpolatedGameState && previousGameState && lastStateUpdateTime > 0) {
      const timeSinceUpdate = now - lastStateUpdateTime;
      const interpolationFactor = Math.min(timeSinceUpdate / TICK_DURATION, 1.0); // Ограничиваем до 1.0
      
      // Интерполируем позиции змеек
      if (interpolatedGameState.my_snake && previousGameState.my_snake) {
        const currentSegments = interpolatedGameState.my_snake.segments || [];
        const previousSegments = previousGameState.my_snake.segments || [];
        if (currentSegments.length > 0 && previousSegments.length > 0) {
          interpolatedMySnake = {
            ...interpolatedGameState.my_snake,
            segments: interpolateSegments(previousSegments, currentSegments, interpolationFactor)
          };
        }
      }
      
      if (interpolatedGameState.opponent_snake && previousGameState.opponent_snake) {
        const currentSegments = interpolatedGameState.opponent_snake.segments || [];
        const previousSegments = previousGameState.opponent_snake.segments || [];
        if (currentSegments.length > 0 && previousSegments.length > 0) {
          interpolatedOppSnake = {
            ...interpolatedGameState.opponent_snake,
            segments: interpolateSegments(previousSegments, currentSegments, interpolationFactor)
          };
        }
      }
    }
    
    // Используем интерполированное состояние или текущее
    const mySnake = interpolatedMySnake || window.appState?.game?.my_snake || interpolatedGameState?.my_snake || currentGameState?.my_snake || currentGame?.initialState?.my_snake;
    const oppSnake = interpolatedOppSnake || window.appState?.game?.opponent_snake || interpolatedGameState?.opponent_snake || currentGameState?.opponent_snake || currentGame?.initialState?.opponent_snake;

    // 5. РАЗНЫЕ ЦВЕТА ЗМЕЕК: Рисуем Змейку Игрока (Зеленая/Неоновая)
    if (mySnake) {
      const mySnakeSegments = mySnake.segments || mySnake.body;
      if (mySnakeSegments && mySnakeSegments.length > 0) {
        try {
          if (!gameCtx) {
            console.error('❌ render: gameCtx отсутствует при попытке нарисовать my_snake');
          } else {
            drawSnakeSimple(mySnake, headHistory, '#00FF41', '#008F11');
            
            // ВИЗУАЛЬНЫЙ ИНДИКАТОР: Рисуем текст "ВЫ" рядом с головой зеленой змейки
            if (mySnakeSegments[0] && mySnakeSegments[0].x !== undefined && mySnakeSegments[0].y !== undefined) {
              gameCtx.save();
              gameCtx.font = "bold 14px Inter, Arial, sans-serif";
              gameCtx.fillStyle = "#00FF41";
              gameCtx.textAlign = "center";
              gameCtx.textBaseline = "bottom";
              gameCtx.shadowBlur = 5;
              gameCtx.shadowColor = "#00FF41";
              const tileSize = canvasLogicalSize / GRID_SIZE;
              const headX = mySnakeSegments[0].x * tileSize;
              const headY = mySnakeSegments[0].y * tileSize;
              gameCtx.fillText("ВЫ", headX + tileSize / 2, headY - 5);
              gameCtx.restore();
            }
          }
        } catch (error) {
          console.error('❌ Ошибка при отрисовке my_snake:', error, 'mySnake:', mySnake);
        }
      }
    }

    // 6. РАЗНЫЕ ЦВЕТА ЗМЕЕК: Рисуем Змейку Оппонента (Красная/Розовая)
    if (oppSnake) {
      const oppSnakeSegments = oppSnake.segments || oppSnake.body;
      if (oppSnakeSegments && oppSnakeSegments.length > 0) {
        try {
          if (!gameCtx) {
            console.error('❌ render: gameCtx отсутствует при попытке нарисовать opponent_snake');
          } else {
            drawSnakeSimple(oppSnake, opponentHeadHistory, '#FF3131', '#8B0000');
          }
        } catch (error) {
          console.error('❌ Ошибка при отрисовке opponent_snake:', error, 'oppSnake:', oppSnake);
        }
      }
    }

    animationFrameId = requestAnimationFrame(render);
  }
  
  animationFrameId = requestAnimationFrame(render);
}

/**
 * ИНТЕРПОЛЯЦИЯ СЕГМЕНТОВ: Плавное движение между состояниями
 */
function interpolateSegments(prevSegments, currentSegments, factor) {
  if (!prevSegments || !currentSegments || prevSegments.length === 0 || currentSegments.length === 0) {
    return currentSegments || prevSegments || [];
  }
  
  const maxLength = Math.max(prevSegments.length, currentSegments.length);
  const interpolated = [];
  
  for (let i = 0; i < maxLength; i++) {
    const prev = prevSegments[i] || prevSegments[prevSegments.length - 1];
    const curr = currentSegments[i] || currentSegments[currentSegments.length - 1];
    
    if (prev && curr) {
      interpolated.push({
        x: prev.x + (curr.x - prev.x) * factor,
        y: prev.y + (curr.y - prev.y) * factor
      });
    } else if (curr) {
      interpolated.push(curr);
    } else if (prev) {
      interpolated.push(prev);
    }
  }
  
  return interpolated;
}

/**
 * STATE MANAGEMENT: Отрисовка змейки как единого пути из window.appState.game.snakes
 * Использует ctx.beginPath() и ctx.lineTo() для создания цельного тела без "дыр"
 * Голова рисуется отдельным ярким элементом
 */
// Флаг для предотвращения бесконечного логирования невалидных координат
let invalidPositionLogged = false;

/**
 * ЦЕЛЬНАЯ ОТРИСОВКА (SNAKE BODY) - БЕЗ КВАДРАТИКОВ
 * Чтобы змейка не выглядела как "пунктир" и не исчезала, используем метод рисования пути
 */
/**
 * ИСПРАВЛЕНИЕ ОТРИСОВКИ: Переписываем drawSnake, чтобы она принимала массив segments и рисовала их как одну сплошную линию
 */
/**
 * ИСПРАВЛЕНИЕ ОТРИСОВКИ ЗМЕЕК: Рисуем каждый сегмент из массива segments с объемом
 */
/**
 * ИСПРАВЛЕНИЕ ОТРИСОВКИ ТЕЛА ЗМЕЙКИ: Сейчас видно только голову. В функции drawSnake убедись, что ты проходишь циклом по ВСЕМУ массиву segments.
 * Логи показывают структуру: window.appState.game.my_snake.segments. Используй именно этот путь.
 */
function drawSnakeSimple(snake, headHistory, color1, color2) {
  // STATE MANAGEMENT: Используем данные из window.appState.game если snake не передан
  if (!snake && window.appState && window.appState.game) {
    const isMySnake = color1 === '#ff4444' || color1 === '#00FF00';
    snake = isMySnake ? window.appState.game.my_snake : window.appState.game.opponent_snake;
  }
  
  // УНИВЕРСАЛЬНАЯ ПРОВЕРКА: Заменяем проверку наличия данных на универсальную
  // const s = snake.segments || snake.body;
  let s = snake?.segments || snake?.body;
  
  // FALLBACK: Если !s, то вместо console.error попробуй взять данные из window.appState.game (как fallback)
  if (!s && window.appState && window.appState.game) {
    const isMySnake = color1 === '#ff4444' || color1 === '#00FF00';
    const fallbackSnake = isMySnake ? window.appState.game.my_snake : window.appState.game.opponent_snake;
    if (fallbackSnake) {
      s = fallbackSnake.segments || fallbackSnake.body;
      snake = fallbackSnake;
    }
  }
  
  // Если s все еще не существует, не рисуем
  if (!s || s.length === 0) {
    return; // Убрали console.error, чтобы не забивать логи
  }
  
  // ОПТИМИЗАЦИЯ: Проверка координат без бесконечного логирования
  const head = s[0];
  if (head.x < 0 || head.x >= GRID_SIZE || head.y < 0 || head.y >= GRID_SIZE) {
    if (!invalidPositionLogged) {
      console.warn(`⚠️ Invalid snake position - x=${head.x}, y=${head.y} (must be 0-${GRID_SIZE-1}). Drawing last valid frame.`);
      invalidPositionLogged = true;
    }
    if (head.x < -5 || head.x > GRID_SIZE + 5 || head.y < -5 || head.y > GRID_SIZE + 5) {
      return;
    }
  } else {
    invalidPositionLogged = false;
  }
  
  // КООРДИНАТЫ И РАЗМЕР: Убедись, что tileSize вычисляется правильно относительно ширины Canvas (canvas.width / 30)
  const tileSize = Math.floor(canvasLogicalSize / GRID_SIZE);
  
  // ИСПРАВЛЕНИЕ: Используем переданные цвета color1 и color2 для отрисовки
  // color1 - цвет головы, color2 - цвет тела
  
  // ДИАГНОСТИКА: Логируем данные для отладки
  if (!gameCtx) {
    console.error('❌ drawSnakeSimple: gameCtx отсутствует!');
    return;
  }
  
  // УЛЬТРА-ФУТУРИСТИЧНЫЙ ВИД: Многослойное свечение и эффекты
  
  const firstSegment = s[0];
  if (!firstSegment) {
    console.warn('⚠️ drawSnakeSimple: первый сегмент отсутствует');
    return;
  }
  
  const lastSegment = s[s.length - 1];
  const headCenterX = firstSegment.x * tileSize + tileSize / 2;
  const headCenterY = firstSegment.y * tileSize + tileSize / 2;
  
  // ========== СЛОЙ 1: ВНЕШНЕЕ СВЕЧЕНИЕ ТЕЛА (самый большой радиус) ==========
  gameCtx.save();
  gameCtx.beginPath();
  gameCtx.strokeStyle = color2 + '40'; // Очень прозрачный
  gameCtx.lineWidth = tileSize * 1.4;
  gameCtx.lineCap = 'round';
  gameCtx.lineJoin = 'round';
  gameCtx.shadowBlur = 30;
  gameCtx.shadowColor = color2;
  gameCtx.shadowOffsetX = 0;
  gameCtx.shadowOffsetY = 0;
  
  const startX = firstSegment.x * tileSize + tileSize / 2;
  const startY = firstSegment.y * tileSize + tileSize / 2;
  gameCtx.moveTo(startX, startY);
  
  for (let i = 1; i < s.length; i++) {
    const segment = s[i];
    if (segment && segment.x !== undefined && segment.y !== undefined) {
      gameCtx.lineTo(segment.x * tileSize + tileSize / 2, segment.y * tileSize + tileSize / 2);
    }
  }
  gameCtx.stroke();
  gameCtx.restore();
  
  // ========== СЛОЙ 2: СРЕДНЕЕ СВЕЧЕНИЕ ТЕЛА ==========
  gameCtx.save();
  const bodyGradient = gameCtx.createLinearGradient(
    s[0].x * tileSize, s[0].y * tileSize,
    lastSegment ? lastSegment.x * tileSize : s[0].x * tileSize,
    lastSegment ? lastSegment.y * tileSize : s[0].y * tileSize
  );
  bodyGradient.addColorStop(0, color1 + 'FF'); // Яркий цвет у головы
  bodyGradient.addColorStop(0.15, color1 + 'DD');
  bodyGradient.addColorStop(0.4, color2 + 'FF');
  bodyGradient.addColorStop(0.7, color2 + 'CC');
  bodyGradient.addColorStop(1, color2 + '80'); // Полупрозрачный у хвоста
  
  gameCtx.beginPath();
  gameCtx.strokeStyle = bodyGradient;
  gameCtx.lineWidth = tileSize * 1.0;
  gameCtx.lineCap = 'round';
  gameCtx.lineJoin = 'round';
  gameCtx.shadowBlur = 20;
  gameCtx.shadowColor = color2;
  gameCtx.shadowOffsetX = 0;
  gameCtx.shadowOffsetY = 0;
  
  gameCtx.moveTo(startX, startY);
  for (let i = 1; i < s.length; i++) {
    const segment = s[i];
    if (segment && segment.x !== undefined && segment.y !== undefined) {
      gameCtx.lineTo(segment.x * tileSize + tileSize / 2, segment.y * tileSize + tileSize / 2);
    }
  }
  gameCtx.stroke();
  gameCtx.restore();
  
  // ========== СЛОЙ 3: ВНУТРЕННЕЕ ЯДРО ТЕЛА (яркое) ==========
  gameCtx.save();
  const coreGradient = gameCtx.createLinearGradient(
    s[0].x * tileSize, s[0].y * tileSize,
    lastSegment ? lastSegment.x * tileSize : s[0].x * tileSize,
    lastSegment ? lastSegment.y * tileSize : s[0].y * tileSize
  );
  coreGradient.addColorStop(0, color1 + 'FF');
  coreGradient.addColorStop(0.2, color1 + 'EE');
  coreGradient.addColorStop(0.5, color2 + 'FF');
  coreGradient.addColorStop(1, color2 + 'AA');
  
  gameCtx.beginPath();
  gameCtx.strokeStyle = coreGradient;
  gameCtx.lineWidth = tileSize * 0.7;
  gameCtx.lineCap = 'round';
  gameCtx.lineJoin = 'round';
  gameCtx.shadowBlur = 15;
  gameCtx.shadowColor = color1;
  
  gameCtx.moveTo(startX, startY);
  for (let i = 1; i < s.length; i++) {
    const segment = s[i];
    if (segment && segment.x !== undefined && segment.y !== undefined) {
      gameCtx.lineTo(segment.x * tileSize + tileSize / 2, segment.y * tileSize + tileSize / 2);
    }
  }
  gameCtx.stroke();
  gameCtx.restore();
  
  // ========== СЛОЙ 4: ЧАСТИЦЫ ВДОЛЬ ТЕЛА (эффект энергии) ==========
  gameCtx.save();
  for (let i = 0; i < s.length; i += 2) { // Каждый второй сегмент
    const segment = s[i];
    if (segment && segment.x !== undefined && segment.y !== undefined) {
      const particleX = segment.x * tileSize + tileSize / 2;
      const particleY = segment.y * tileSize + tileSize / 2;
      const particleSize = (tileSize * 0.15) * (1 - i / s.length * 0.5); // Меньше к хвосту
      
      const particleGradient = gameCtx.createRadialGradient(
        particleX, particleY, 0,
        particleX, particleY, particleSize
      );
      particleGradient.addColorStop(0, color1 + 'FF');
      particleGradient.addColorStop(0.5, color2 + 'AA');
      particleGradient.addColorStop(1, color2 + '00');
      
      gameCtx.fillStyle = particleGradient;
      gameCtx.shadowBlur = 10;
      gameCtx.shadowColor = color2;
      gameCtx.beginPath();
      gameCtx.arc(particleX, particleY, particleSize, 0, Math.PI * 2);
      gameCtx.fill();
    }
  }
  gameCtx.restore();
  
  // ========== СЛОЙ 5: УЛЬТРА-ФУТУРИСТИЧНАЯ ГОЛОВА ==========
  gameCtx.save();
  
  // Внешнее свечение головы (самое большое)
  gameCtx.shadowBlur = 35;
  gameCtx.shadowColor = color1;
  gameCtx.fillStyle = color1 + '60';
  gameCtx.beginPath();
  gameCtx.arc(headCenterX, headCenterY, tileSize / 1.8, 0, Math.PI * 2);
  gameCtx.fill();
  
  // Среднее свечение головы
  const headOuterGradient = gameCtx.createRadialGradient(
    headCenterX, headCenterY, 0,
    headCenterX, headCenterY, tileSize / 2.0
  );
  headOuterGradient.addColorStop(0, color1 + 'FF');
  headOuterGradient.addColorStop(0.5, color1 + 'DD');
  headOuterGradient.addColorStop(1, color1 + '88');
  
  gameCtx.shadowBlur = 25;
  gameCtx.shadowColor = color1;
  gameCtx.fillStyle = headOuterGradient;
  gameCtx.beginPath();
  gameCtx.arc(headCenterX, headCenterY, tileSize / 2.2, 0, Math.PI * 2);
  gameCtx.fill();
  
  // Внутреннее ядро головы (самое яркое)
  const headCoreGradient = gameCtx.createRadialGradient(
    headCenterX, headCenterY, 0,
    headCenterX, headCenterY, tileSize / 3.2
  );
  headCoreGradient.addColorStop(0, '#FFFFFF');
  headCoreGradient.addColorStop(0.3, color1 + 'FF');
  headCoreGradient.addColorStop(1, color1 + 'AA');
  
  gameCtx.shadowBlur = 20;
  gameCtx.shadowColor = '#FFFFFF';
  gameCtx.fillStyle = headCoreGradient;
  gameCtx.beginPath();
  gameCtx.arc(headCenterX, headCenterY, tileSize / 3.2, 0, Math.PI * 2);
  gameCtx.fill();
  
  // Центральное ядро (белое свечение)
  gameCtx.fillStyle = '#FFFFFF';
  gameCtx.shadowBlur = 15;
  gameCtx.shadowColor = '#FFFFFF';
  gameCtx.beginPath();
  gameCtx.arc(headCenterX, headCenterY, tileSize / 5, 0, Math.PI * 2);
  gameCtx.fill();
  
  // ========== СЛОЙ 6: УЛУЧШЕННЫЕ ГЛАЗА ==========
  const direction = snake.direction || { dx: 1, dy: 0 };
  const eyeSize = tileSize / 5.5;
  const eyeOffsetX = tileSize / 3.2;
  const eyeOffsetY = tileSize / 4.5;
  
  let leftEyeX, leftEyeY, rightEyeX, rightEyeY;
  
  if (direction.dx > 0) { // Вправо
    leftEyeX = headCenterX - eyeOffsetX * 0.3;
    leftEyeY = headCenterY - eyeOffsetY;
    rightEyeX = headCenterX - eyeOffsetX * 0.3;
    rightEyeY = headCenterY + eyeOffsetY;
  } else if (direction.dx < 0) { // Влево
    leftEyeX = headCenterX + eyeOffsetX * 0.3;
    leftEyeY = headCenterY - eyeOffsetY;
    rightEyeX = headCenterX + eyeOffsetX * 0.3;
    rightEyeY = headCenterY + eyeOffsetY;
  } else if (direction.dy > 0) { // Вниз
    leftEyeX = headCenterX - eyeOffsetY;
    leftEyeY = headCenterY - eyeOffsetX * 0.3;
    rightEyeX = headCenterX + eyeOffsetY;
    rightEyeY = headCenterY - eyeOffsetX * 0.3;
  } else { // Вверх
    leftEyeX = headCenterX - eyeOffsetY;
    leftEyeY = headCenterY + eyeOffsetX * 0.3;
    rightEyeX = headCenterX + eyeOffsetY;
    rightEyeY = headCenterY + eyeOffsetX * 0.3;
  }
  
  // Внешнее свечение глаз
  gameCtx.shadowBlur = 12;
  gameCtx.shadowColor = '#FFFFFF';
  gameCtx.fillStyle = '#FFFFFF' + 'DD';
  gameCtx.beginPath();
  gameCtx.arc(leftEyeX, leftEyeY, eyeSize * 1.2, 0, Math.PI * 2);
  gameCtx.fill();
  gameCtx.beginPath();
  gameCtx.arc(rightEyeX, rightEyeY, eyeSize * 1.2, 0, Math.PI * 2);
  gameCtx.fill();
  
  // Основные глаза (белые с градиентом)
  const eyeGradient = gameCtx.createRadialGradient(
    leftEyeX, leftEyeY, 0,
    leftEyeX, leftEyeY, eyeSize
  );
  eyeGradient.addColorStop(0, '#FFFFFF');
  eyeGradient.addColorStop(1, '#FFFFFF' + 'AA');
  
  gameCtx.fillStyle = eyeGradient;
  gameCtx.shadowBlur = 10;
  gameCtx.beginPath();
  gameCtx.arc(leftEyeX, leftEyeY, eyeSize, 0, Math.PI * 2);
  gameCtx.fill();
  
  const eyeGradient2 = gameCtx.createRadialGradient(
    rightEyeX, rightEyeY, 0,
    rightEyeX, rightEyeY, eyeSize
  );
  eyeGradient2.addColorStop(0, '#FFFFFF');
  eyeGradient2.addColorStop(1, '#FFFFFF' + 'AA');
  
  gameCtx.fillStyle = eyeGradient2;
  gameCtx.beginPath();
  gameCtx.arc(rightEyeX, rightEyeY, eyeSize, 0, Math.PI * 2);
  gameCtx.fill();
  
  // Зрачки (черные с небольшим свечением)
  gameCtx.fillStyle = '#000000';
  gameCtx.shadowBlur = 5;
  gameCtx.shadowColor = '#000000';
  gameCtx.beginPath();
  gameCtx.arc(leftEyeX, leftEyeY, eyeSize / 2.2, 0, Math.PI * 2);
  gameCtx.fill();
  gameCtx.beginPath();
  gameCtx.arc(rightEyeX, rightEyeY, eyeSize / 2.2, 0, Math.PI * 2);
  gameCtx.fill();
  
  // Блики в глазах (белые точки)
  gameCtx.fillStyle = '#FFFFFF';
  gameCtx.shadowBlur = 0;
  gameCtx.beginPath();
  gameCtx.arc(leftEyeX - eyeSize / 4, leftEyeY - eyeSize / 4, eyeSize / 4, 0, Math.PI * 2);
  gameCtx.fill();
  gameCtx.beginPath();
  gameCtx.arc(rightEyeX - eyeSize / 4, rightEyeY - eyeSize / 4, eyeSize / 4, 0, Math.PI * 2);
  gameCtx.fill();
  
  gameCtx.restore();
}

/**
 * Рисование сетки на offscreen canvas (один раз для оптимизации)
 */
function drawGridToOffscreen() {
  if (!gridCtx) return;
  
  // СИНХРОНИЗАЦИЯ СЕТКИ: используем константу GRID_SIZE для синхронизации с сервером
  const tileSize = canvasLogicalSize / GRID_SIZE; // GRID_SIZE клеток по ширине
  const width = canvasLogicalSize;
  const height = canvasLogicalSize;
  
  // Более яркие линии сетки для лучшей видимости
  gridCtx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
  gridCtx.lineWidth = 0.5;
  
  for (let i = 0; i <= GRID_SIZE; i++) {
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
 * ОРТОДОКСАЛЬНОЕ ДВИЖЕНИЕ ПО СЕТКЕ: строгие повороты под 90 градусов
 * L-образные повороты вместо диагональных, коррекция хвоста из истории
 */
function interpolateSnake(previousSnake, currentSnake, t, tickDiff = 1, gameStatesBuffer = [], snakeKey = 'my_snake') {
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
  
  // Создаем новый объект змейки
  const interpolated = {
    body: [],
    direction: { ...currentSnake.direction },
    alive: currentSnake.alive
  };
  
  // Направление меняется мгновенно
  interpolated.direction = { ...currentSnake.direction };
  
  const headIndex = 0;
  const prevHead = previousSnake.body[headIndex];
  const currHead = currentSnake.body[headIndex];
  
  // УМНАЯ ИНТЕРПОЛЯЦИЯ ПОВОРОТОВ: если изменились и X, и Y - это поворот
  const dx = currHead.x - prevHead.x;
  const dy = currHead.y - prevHead.y;
  const isTurn = (dx !== 0 && dy !== 0); // Если изменились обе координаты - был поворот
  
  if (isTurn) {
    // ОРТОДОКСАЛЬНОЕ ДВИЖЕНИЕ: разделяем интерполяцию на две фазы
    // Определяем направление движения ДО поворота (из предыдущего состояния)
    const prevDirection = previousSnake.direction;
    const wasMovingHorizontally = Math.abs(prevDirection.dx) > Math.abs(prevDirection.dy);
    
    if (interpolationT < 0.5) {
      // ПЕРВАЯ ФАЗА (t < 0.5): двигаемся только по той оси, по которой двигались до этого
      if (wasMovingHorizontally) {
        // Двигались горизонтально - продолжаем по X
        interpolated.body[headIndex] = {
          x: prevHead.x + dx * (interpolationT * 2), // Ускоряем в 2 раза для первой половины
          y: prevHead.y // Фиксируем Y на старой позиции
        };
      } else {
        // Двигались вертикально - продолжаем по Y
        interpolated.body[headIndex] = {
          x: prevHead.x, // Фиксируем X на старой позиции
          y: prevHead.y + dy * (interpolationT * 2) // Ускоряем в 2 раза для первой половины
        };
      }
    } else {
      // ВТОРАЯ ФАЗА (t >= 0.5): начинаем движение по новой оси
      if (wasMovingHorizontally) {
        // Были на горизонтали - теперь двигаемся по Y
        interpolated.body[headIndex] = {
          x: currHead.x, // Фиксируем X на конечной позиции
          y: prevHead.y + dy * ((interpolationT - 0.5) * 2) // Двигаемся по Y
        };
      } else {
        // Были на вертикали - теперь двигаемся по X
        interpolated.body[headIndex] = {
          x: prevHead.x + dx * ((interpolationT - 0.5) * 2), // Двигаемся по X
          y: currHead.y // Фиксируем Y на конечной позиции
        };
      }
    }
  } else {
    // Обычное движение без поворота - линейная интерполяция
    interpolated.body[headIndex] = {
      x: prevHead.x + dx * interpolationT,
      y: prevHead.y + dy * interpolationT
    };
  }
  
  // КОРРЕКЦИЯ ХВОСТА (Tail Anchoring): запрет на 'плавание' сегментов
  // Каждый сегмент хвоста должен находиться строго на расстоянии 1 клетки от предыдущего
  // Используем позиции из истории gameStatesBuffer для точного позиционирования
  const GRID_SIZE = 1; // Размер одной клетки игрового поля
  
  // Начинаем с головы и выстраиваем хвост по цепочке
  for (let i = 1; i < currentSnake.body.length; i++) {
    const prevSegment = interpolated.body[i - 1]; // Предыдущий сегмент (голова или предыдущий сегмент хвоста)
    
    // КОРРЕКЦИЯ ИЗ ИСТОРИИ: ищем позицию сегмента из предыдущих состояний gameStatesBuffer
    // Сегмент i должен находиться в позиции, где он был в предыдущих состояниях
    let targetSegmentPos = null;
    
    // Ищем в истории состояние, где сегмент i был на корректной позиции
    // Используем самое старое доступное состояние из буфера
    for (let j = 0; j < gameStatesBuffer.length; j++) {
      const historyState = gameStatesBuffer[j];
      if (historyState && historyState[snakeKey] && historyState[snakeKey].body && 
          i < historyState[snakeKey].body.length) {
        const historySegment = historyState[snakeKey].body[i];
        // Используем позицию из истории как целевую
        targetSegmentPos = { x: historySegment.x, y: historySegment.y };
        break; // Берем первое найденное состояние
      }
    }
    
    // Если нашли позицию из истории, используем её с выравниванием расстояния
    if (targetSegmentPos) {
      // Вычисляем вектор от предыдущего сегмента к целевой позиции
      let segmentDx = targetSegmentPos.x - prevSegment.x;
      let segmentDy = targetSegmentPos.y - prevSegment.y;
      const segmentDistance = Math.sqrt(segmentDx * segmentDx + segmentDy * segmentDy);
      
      if (segmentDistance > 0) {
        // Нормализуем и устанавливаем расстояние ровно в 1 единицу
        segmentDx = (segmentDx / segmentDistance) * GRID_SIZE;
        segmentDy = (segmentDy / segmentDistance) * GRID_SIZE;
        interpolated.body[i] = {
          x: prevSegment.x - segmentDx, // Вычитаем, так как хвост идет назад от головы
          y: prevSegment.y - segmentDy
        };
      } else {
        // Если расстояние 0, используем направление из предыдущего состояния
        if (i < previousSnake.body.length && i > 0) {
          const prevPrevSegment = previousSnake.body[i - 1];
          const prevCurrSegment = previousSnake.body[i];
          segmentDx = prevCurrSegment.x - prevPrevSegment.x;
          segmentDy = prevCurrSegment.y - prevPrevSegment.y;
          const prevDistance = Math.sqrt(segmentDx * segmentDx + segmentDy * segmentDy);
          if (prevDistance > 0) {
            segmentDx = (segmentDx / prevDistance) * GRID_SIZE;
            segmentDy = (segmentDy / prevDistance) * GRID_SIZE;
          } else {
            segmentDx = currentSnake.direction.dx * GRID_SIZE;
            segmentDy = currentSnake.direction.dy * GRID_SIZE;
          }
        } else {
          segmentDx = currentSnake.direction.dx * GRID_SIZE;
          segmentDy = currentSnake.direction.dy * GRID_SIZE;
        }
        interpolated.body[i] = {
          x: prevSegment.x - segmentDx,
          y: prevSegment.y - segmentDy
        };
      }
    } else {
      // Fallback: используем текущее состояние и выравниваем расстояние
      const currSegment = currentSnake.body[i];
      let segmentDx = currSegment.x - prevSegment.x;
      let segmentDy = currSegment.y - prevSegment.y;
      const segmentDistance = Math.sqrt(segmentDx * segmentDx + segmentDy * segmentDy);
      
      if (segmentDistance > 0) {
        // Нормализуем и устанавливаем расстояние ровно в 1 единицу
        segmentDx = (segmentDx / segmentDistance) * GRID_SIZE;
        segmentDy = (segmentDy / segmentDistance) * GRID_SIZE;
      } else {
        // Если сегменты на одной позиции, используем направление змейки
        segmentDx = currentSnake.direction.dx * GRID_SIZE;
        segmentDy = currentSnake.direction.dy * GRID_SIZE;
      }
      
      // Позиционируем сегмент на расстоянии ровно 1 единица от предыдущего
      interpolated.body[i] = {
        x: prevSegment.x - segmentDx, // Вычитаем, так как хвост идет назад от головы
        y: prevSegment.y - segmentDy
      };
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
 * Рисование змейки (оптимизированная версия без Math.sqrt и с кэшированием градиента/shadow)
 */
function drawSnake(snake, color1, color2) {
  if (!snake || !snake.body || snake.body.length === 0) return;
  
  // Используем логический размер canvas (без DPR) для корректной отрисовки
  const tileSize = canvasLogicalSize / 30; // 30 клеток по ширине
  
  // ОПТИМИЗАЦИЯ: берем направление напрямую из snake.direction без перерасчета
  // Если direction отсутствует или некорректно, используем fallback
  let direction = snake.direction;
  if (!direction || (direction.dx === 0 && direction.dy === 0)) {
    // Fallback: красная змейка вправо, синяя влево
    direction = color1 === '#ff4444' ? { dx: 1, dy: 0 } : { dx: -1, dy: 0 };
  }
  
  // ОПТИМИЗАЦИЯ: нормализуем направление БЕЗ Math.sqrt и Math.abs
  // Для единичных векторов (dx, dy) = (-1,0), (1,0), (0,-1), (0,1) нормализация не нужна
  // Проверяем только если это не единичный вектор
  const dx = direction.dx;
  const dy = direction.dy;
  if (dx !== 0 && dx !== 1 && dx !== -1 && dy !== 0 && dy !== 1 && dy !== -1) {
    // Только если это не стандартное направление, нормализуем (но без Math.sqrt и Math.abs)
    // Используем приближение: если dx > 0 или dx < 0, то нормализуем по dx, иначе по dy
    if (dx > 0 || dx < 0) {
      direction = { dx: dx > 0 ? 1 : -1, dy: 0 };
    } else {
      direction = { dx: 0, dy: dy > 0 ? 1 : -1 };
    }
  }
  
  // ОПТИМИЗАЦИЯ: создаем градиент и настраиваем shadow ОДИН РАЗ перед циклом
  const gradient = gameCtx.createLinearGradient(0, 0, gameCanvas.width, gameCanvas.height);
  gradient.addColorStop(0, color1); // Яркий цвет
  gradient.addColorStop(0.5, color2); // Средний цвет
  gradient.addColorStop(1, color1); // Темный оттенок для объема
  
  // Настраиваем shadow эффекты один раз
  gameCtx.shadowColor = color1;
  gameCtx.shadowBlur = 18; // Увеличенная интенсивность для лучшей видимости
  gameCtx.shadowOffsetX = 0;
  gameCtx.shadowOffsetY = 0;
  
  // ИСПРАВЛЕНИЕ: Используем s (segments или body) вместо snake.body
  // ОПТИМИЗАЦИЯ FPS: для длинных змеек используем упрощенную отрисовку
  const isLongSnake = s && s.length > 10;
  
  if (!s || s.length === 0) return; // Защита от пустого массива
  
  s.forEach((segment, index) => {
    const x = segment.x * tileSize;
    const y = segment.y * tileSize;
    const size = tileSize - 2;
    const offset = 1;
    const radius = size * (index === 0 ? 0.2 : 0.15);
    
    if (index === 0) {
      // Голова - рисуем с градиентом и скруглениями (всегда с эффектами)
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
      const centerX = x + offset + size / 2;
      const centerY = y + offset + size / 2;
      const eyeOffset = size * 0.2;
      const eyeSize = size * 0.12;
      
      let eyeX1, eyeY1, eyeX2, eyeY2;
      
      // Определяем позицию глаз на основе направления
        if (direction.dx > 0) {
          eyeX1 = centerX + eyeOffset * 0.5;
          eyeY1 = centerY - eyeOffset * 0.5;
          eyeX2 = centerX + eyeOffset * 0.5;
          eyeY2 = centerY + eyeOffset * 0.5;
        } else if (direction.dx < 0) {
          eyeX1 = centerX - eyeOffset * 0.5;
          eyeY1 = centerY - eyeOffset * 0.5;
          eyeX2 = centerX - eyeOffset * 0.5;
          eyeY2 = centerY + eyeOffset * 0.5;
        } else if (direction.dy > 0) {
          eyeX1 = centerX - eyeOffset * 0.5;
          eyeY1 = centerY + eyeOffset * 0.5;
          eyeX2 = centerX + eyeOffset * 0.5;
          eyeY2 = centerY + eyeOffset * 0.5;
        } else {
        eyeX1 = centerX - eyeOffset * 0.5;
        eyeY1 = centerY - eyeOffset * 0.5;
        eyeX2 = centerX + eyeOffset * 0.5;
        eyeY2 = centerY - eyeOffset * 0.5;
      }
      
      // Рисуем глаза
      gameCtx.shadowColor = 'rgba(255, 255, 255, 0.5)';
      gameCtx.shadowBlur = 3;
      gameCtx.fillStyle = '#ffffff';
      gameCtx.beginPath();
      gameCtx.arc(eyeX1, eyeY1, eyeSize, 0, Math.PI * 2);
      gameCtx.fill();
      gameCtx.beginPath();
      gameCtx.arc(eyeX2, eyeY2, eyeSize, 0, Math.PI * 2);
      gameCtx.fill();
    } else if (index === 1) {
      // Первая секция (шея) - сглаживание только здесь, соединяет голову и тело
      gameCtx.fillStyle = gradient;
      gameCtx.beginPath();
      gameCtx.roundRect(x + offset + 1, y + offset + 1, size - 2, size - 2, radius);
      gameCtx.fill();
    } else {
      // Остальное тело - упрощенная отрисовка без теней для производительности
      // Отключаем сглаживание для хвоста - жесткие координаты
      if (isLongSnake && index > 5) {
        // Для длинных змеек: упрощенная отрисовка без теней
        gameCtx.shadowBlur = 0;
        gameCtx.shadowColor = 'transparent';
      }
      gameCtx.fillStyle = gradient;
      gameCtx.beginPath();
      gameCtx.roundRect(x + offset + 1, y + offset + 1, size - 2, size - 2, radius);
      gameCtx.fill();
    }
  });
    
  // ОПТИМИЗАЦИЯ: сбрасываем shadow эффекты один раз после цикла
    gameCtx.shadowBlur = 0;
    gameCtx.shadowColor = 'transparent';
}

/**
 * Отображение preview игры на указанном canvas
 */
/**
 * IN-MEMORY STATE: Отрисовка preview игры используя gameStateJSON
 * Используется во время countdown для показа начального состояния змеек
 */
function renderGamePreviewOnCanvas(gameState, canvas, ctx) {
  if (!canvas || !ctx) {
    console.error('❌ renderGamePreviewOnCanvas: canvas или ctx отсутствуют');
    return;
  }
  
  // IN-MEMORY STATE: Используем gameStateJSON если gameState не передан
  const stateToRender = gameState || gameStateJSON;
  if (!stateToRender) {
    console.warn('⚠️ renderGamePreviewOnCanvas: нет данных для отрисовки');
    return;
  }
  
  // Используем логический размер для отрисовки (canvas уже масштабирован через DPR)
  const logicalSize = canvasLogicalSize || 600;
  
  // Очищаем canvas (используем логический размер, так как контекст уже масштабирован)
  ctx.clearRect(0, 0, logicalSize, logicalSize);
  
  // Заливаем фон игрового поля
  ctx.fillStyle = '#0a0e27';
  ctx.fillRect(0, 0, logicalSize, logicalSize);
  
  // Рисуем сетку (30x30)
  const tileSize = logicalSize / GRID_SIZE;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
  ctx.lineWidth = 0.5;
  
  for (let i = 0; i <= GRID_SIZE; i++) {
    // Vertical lines
    ctx.beginPath();
    ctx.moveTo(i * tileSize, 0);
    ctx.lineTo(i * tileSize, logicalSize);
    ctx.stroke();
    
    // Horizontal lines
    ctx.beginPath();
    ctx.moveTo(0, i * tileSize);
    ctx.lineTo(logicalSize, i * tileSize);
    ctx.stroke();
  }
  
  // IN-MEMORY STATE: Используем drawSnakeSimple для отрисовки змеек из gameStateJSON
  // Это обеспечивает единый стиль отрисовки во время countdown и во время игры
  if (stateToRender.my_snake) {
    drawSnakeSimple(stateToRender.my_snake, [], '#ff4444', '#ff6666');
  }
  if (stateToRender.opponent_snake) {
    drawSnakeSimple(stateToRender.opponent_snake, [], '#4444ff', '#6666ff');
  }
}

/**
 * Завершение игры
 */

/**
 * Завершение игры
 */
function endGame(data) {
  console.log('🎯 endGame called, data:', data);
  console.log('Attempting to show results screen...');
  
  // ИСПРАВЛЕНИЕ: Останавливаем рендеринг при завершении игры
  isRendering = false;
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
    console.log('🛑 Render loop stopped after game end');
  }
  
  // IN-MEMORY STATE: Обновляем gameStateJSON финальным состоянием перед очисткой
  if (data) {
    gameStateJSON.finished = true;
    gameStateJSON.game_finished = true;
  }
  
  // Принудительная остановка игрового состояния
  gameState = 'result';
  currentGame = null; // This will stop updates via game_state
  
  // Сбрасываем флаг логирования невалидных координат
  invalidPositionLogged = false;
  
  // ВАЖНО: gameStateJSON остается в памяти до следующего матча
  // В БД записываются только финальные результаты (выигрыш, история)
  
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




