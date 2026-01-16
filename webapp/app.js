// Telegram Web App интеграция
let tg = window.Telegram.WebApp;
let game = null;
let gameLoop = null;
let currentDirection = null;
let userData = null;
let userId = null; // ИЗОЛЯЦИЯ ПОЛЬЗОВАТЕЛЯ: user_id всегда из Telegram
let gameState = 'menu'; // menu, payment, waiting, countdown, playing, result

// WEBSOCKETS: Socket.IO з'єднання
let socket = null;
let gameStateSyncInterval = null; // Буде замінено на WebSocket listeners
let ghostOpponentPosition = null; // Ghost позиція для резерву при мережевих помилках
let gameStartTimestamp = null; // Timestamp старту гри для синхронізації countdown
let gameEndCalled = false; // Флаг для запобігання повторному виклику endGame

// Константы
const GAME_START_DELAY = 5;

// WEBSOCKETS: Ініціалізація WebSocket з'єднання
function initWebSocket() {
    if (!userId || !window.io) {
        console.warn('WebSocket: userId or Socket.IO not available');
        return;
    }
    
    const baseUrl = window.location.origin;
    
    // Підключаємося до WebSocket сервера
    socket = io(baseUrl, {
        auth: {
            user_id: userId
        },
        transports: ['websocket', 'polling']
    });
    
    // Обробник підключення
    socket.on('connect', () => {
        console.log('WebSocket connected:', socket.id);
    });
    
    // Обробник відключення
    socket.on('disconnect', () => {
        console.warn('WebSocket disconnected');
    });
    
    // WEBSOCKETS: Отримання оновлень стану гри в реальному часі
    socket.on('game_state', (data) => {
        if (!game || gameState !== 'playing') return;
        
        try {
            // Синхронізація позиції оппонента з сервера
            if (data.opponent_snake && data.opponent_snake.body) {
                const opponentBody = data.opponent_snake.body.map(pos => ({x: pos[0], y: pos[1]}));
                game.player2.body = opponentBody;
                game.player2.alive = data.opponent_snake.alive !== false;
                
                // Синхронізація напрямку оппонента
                if (data.opponent_snake.direction) {
                    if (Array.isArray(data.opponent_snake.direction)) {
                        game.player2.direction = {x: data.opponent_snake.direction[0], y: data.opponent_snake.direction[1]};
                        game.player2.nextDirection = {x: data.opponent_snake.direction[0], y: data.opponent_snake.direction[1]};
                    } else if (data.opponent_snake.direction.x !== undefined) {
                        game.player2.direction = {x: data.opponent_snake.direction.x, y: data.opponent_snake.direction.y};
                        game.player2.nextDirection = {x: data.opponent_snake.direction.x, y: data.opponent_snake.direction.y};
                    }
                }
                
                ghostOpponentPosition = JSON.parse(JSON.stringify(opponentBody));
            }
            
            // Синхронізація власної змійки для корекції розсинхронізації
            if (data.my_snake && data.my_snake.body) {
                const myBody = data.my_snake.body.map(pos => ({x: pos[0], y: pos[1]}));
                if (game.player1.body.length > 0) {
                    const headDiff = Math.abs(game.player1.body[0].x - myBody[0].x) + Math.abs(game.player1.body[0].y - myBody[0].y);
                    if (headDiff > 2) {
                        game.player1.body = myBody;
                    }
                } else {
                    game.player1.body = myBody;
                }
                game.player1.alive = data.my_snake.alive !== false;
            }
            
            // Перевірка завершення гри
            if (data.game_finished && !gameEndCalled) {
                gameEndCalled = true;
                endGameFromServer(data);
            }
        } catch (error) {
            console.error('Error processing game_state:', error);
        }
    });
    
    // WEBSOCKETS: Обидва гравці готові - починаємо countdown
    socket.on('both_ready', (data) => {
        console.log('Both players ready, starting countdown:', data);
        if (data.game_start_timestamp) {
            gameStartTimestamp = data.game_start_timestamp;
        }
        checkServerStartStatus();
    });
    
    // WEBSOCKETS: Підтвердження збереження команди напрямку
    socket.on('direction_queued', (data) => {
        // Команда успішно збережена для наступного тику
        if (data.success) {
            // Можна додати візуальне підтвердження, якщо потрібно
        }
    });
    
    // WEBSOCKETS: Підтвердження готовності
    socket.on('ready_confirmed', (data) => {
        console.log('Ready confirmed:', data);
    });
    
    // WEBSOCKETS: Обробка помилок
    socket.on('error', (error) => {
        console.error('WebSocket error:', error);
        if (error.message) {
            tg.showAlert('Помилка: ' + error.message);
        }
    });
}

// Инициализация
document.addEventListener('DOMContentLoaded', async () => {
    tg.ready();
    tg.expand();
    
    // TELEGRAM INTEGRATION: Получаем user_id из window.Telegram.WebApp.initDataUnsafe.user.id
    userData = tg.initDataUnsafe?.user;
    userId = userData?.id || null;
    
    if (!userId) {
        console.error('ERROR: user_id not found in tg.initDataUnsafe.user.id');
        tg.showAlert('Ошибка: не удалось определить пользователя. Перезагрузите приложение.');
        showScreen('menu');
        return;
    }
    
    // Инициализируем игру
    initEventListeners();
    
    // Показываем загрузку
    showScreen('loading');
    
    // WEBSOCKETS: Ініціалізуємо WebSocket з'єднання (з затримкою, щоб Socket.IO встиг завантажитися)
    // Перевіряємо, чи Socket.IO завантажився
    if (window.io) {
        initWebSocket();
    } else {
        // Якщо Socket.IO ще не завантажився, чекаємо трохи
        setTimeout(() => {
            if (window.io) {
                initWebSocket();
            } else {
                console.warn('Socket.IO не завантажився, WebSocket не буде доступний');
            }
        }, 500);
    }
    
    // Проверяем состояние игры при загрузке (з timeout для избежания зависания)
    try {
        const statusCheckPromise = checkGameState();
        const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(false), 5000)); // 5 секунд timeout
        
        const statusRestored = await Promise.race([statusCheckPromise, timeoutPromise]);
        
        // Если статус не восстановлен или timeout, показываем меню
        if (!statusRestored && (gameState === 'menu' || !document.getElementById('menu-screen')?.classList.contains('active'))) {
            showScreen('menu');
        }
    } catch (error) {
        console.error('Error during initialization:', error);
        // При любой ошибке показываем меню
        showScreen('menu');
    }
});

// Инициализация обработчиков событий
function initEventListeners() {
    // Главное меню
    document.getElementById('start-game-btn').addEventListener('click', startGame);
    
    // Платежный экран - обработчики устанавливаются динамически в showPaymentScreen
    document.getElementById('check-payment-btn').addEventListener('click', checkPayment);
    
    // Экран ожидания
    document.getElementById('check-payment-waiting-btn').addEventListener('click', checkPayment);
    
    // Игровые кнопки
    document.getElementById('btn-up').addEventListener('click', () => handleDirection('up'));
    document.getElementById('btn-down').addEventListener('click', () => handleDirection('down'));
    document.getElementById('btn-left').addEventListener('click', () => handleDirection('left'));
    document.getElementById('btn-right').addEventListener('click', () => handleDirection('right'));
    
    // Результаты
    document.getElementById('play-again-btn').addEventListener('click', playAgain);
    document.getElementById('close-btn').addEventListener('click', closeGame);
    
    // Свайпы для управления
    let touchStartX = 0;
    let touchStartY = 0;
    
    const canvas = document.getElementById('game-canvas');
    canvas.addEventListener('touchstart', (e) => {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
    });
    
    canvas.addEventListener('touchend', (e) => {
        if (!touchStartX || !touchStartY) return;
        
        const touchEndX = e.changedTouches[0].clientX;
        const touchEndY = e.changedTouches[0].clientY;
        
        const diffX = touchStartX - touchEndX;
        const diffY = touchStartY - touchEndY;
        
        if (Math.abs(diffX) > Math.abs(diffY)) {
            if (diffX > 0) handleDirection('left');
            else handleDirection('right');
        } else {
            if (diffY > 0) handleDirection('up');
            else handleDirection('down');
        }
        
        touchStartX = 0;
        touchStartY = 0;
    });
    
    // Клавиатурное управление
    document.addEventListener('keydown', (e) => {
        if (gameState !== 'playing') return;
        
        switch(e.key) {
            case 'ArrowUp':
                e.preventDefault();
                handleDirection('up');
                break;
            case 'ArrowDown':
                e.preventDefault();
                handleDirection('down');
                break;
            case 'ArrowLeft':
                e.preventDefault();
                handleDirection('left');
                break;
            case 'ArrowRight':
                e.preventDefault();
                handleDirection('right');
                break;
        }
    });
}

// Показ экранов
function showScreen(screenName) {
    document.querySelectorAll('.screen').forEach(screen => {
        screen.classList.remove('active');
    });
    
    const screen = document.getElementById(screenName + '-screen');
    if (screen) {
        screen.classList.add('active');
        gameState = screenName;
    }
}

// Начало игры
async function startGame() {
    showScreen('loading');
    
    try {
        // Отправляем запрос на сервер для создания/присоединения к игре
        const baseUrl = window.location.origin;
        console.log('Starting game, baseUrl:', baseUrl);
        console.log('User data:', userData);
        
        // VALIDATION: Проверяем user_id (обязательное поле для всех запросов)
        if (!userId) {
            console.error('ERROR: user_id is required but not found');
            tg.showAlert('Ошибка: данные пользователя не найдены. Перезагрузите приложение.');
            showScreen('menu');
            return;
        }
        
        // VALIDATION: Стандартизированные JSON ключи для всех запросов
        const requestData = {
            user_id: userId,  // Всегда отправляем user_id для изоляции пользователя
            init_data: tg.initData || tg.initDataUnsafe || ''
        };
        console.log('Sending request:', requestData);
        
        const response = await fetch(`${baseUrl}/api/game/start`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestData)
        });
        
        console.log('Response status:', response.status, response.statusText);
        
        // Проверяем статус ответа
        if (!response.ok) {
            const errorText = await response.text();
            console.error('API error response:', errorText);
            try {
                const errorData = JSON.parse(errorText);
                tg.showAlert(errorData.error || `Ошибка сервера: ${response.status}`);
            } catch (e) {
                tg.showAlert(`Ошибка сервера: ${response.status}`);
            }
            showScreen('menu');
            return;
        }
        
        const data = await response.json();
        console.log('Response data:', data);
        
        if (data.error) {
            console.error('Error in response:', data.error);
            tg.showAlert(data.error);
            showScreen('menu');
            return;
        }
        
        // PAYMENT DISABLED: Оплата отключена, обрабатываем статусы без оплаты
        if (data.requires_payment) {
            if (data.invoice_url) {
                console.log('Showing payment screen with URL:', data.invoice_url);
                showPaymentScreen(data.invoice_url);
            } else {
                console.error('No invoice_url in response:', data);
                tg.showAlert('Ошибка: не получен URL для оплаты');
                showScreen('menu');
            }
        } else if (data.waiting || data.status === 'waiting_opponent') {
            // Ожидание соперника - показываем экран ожидания и начинаем polling
            console.log('Game waiting for opponent, status:', data.status);
            showWaitingScreen();
        } else if (data.game_starting || data.status === 'ready_to_start') {
            // Игра начинается - запускаем обратный отсчет (только когда оба игрока подключены)
            console.log('Game starting (both players connected), status:', data.status, 'game_starting:', data.game_starting);
            startCountdown(data.countdown || GAME_START_DELAY || 5);
        } else if (data.in_game && data.game_running) {
            // Игрок уже в активной игре (игра уже идет)
            console.log('Player already in running game');
            // Игра уже идет, переходим к игровому экрану
            startGamePlay();
        } else {
            // Неизвестный статус - показываем ошибку
            console.error('Unknown game status:', data);
            console.error('Status keys:', Object.keys(data));
            tg.showAlert('Неизвестный статус игры: ' + (data.status || 'no status'));
            showScreen('menu');
        }
    } catch (error) {
        console.error('Error starting game:', error);
        console.error('Error details:', {
            name: error.name,
            message: error.message,
            stack: error.stack
        });
        tg.showAlert(`Ошибка при запуске игры: ${error.message || 'Неизвестная ошибка'}`);
        showScreen('menu');
    }
}

// Показ экрана оплаты
function showPaymentScreen(invoiceUrl) {
    if (!invoiceUrl || invoiceUrl === '#' || invoiceUrl === '') {
        console.error('Invalid invoice URL:', invoiceUrl);
        tg.showAlert('Ошибка: не получен URL для оплаты');
        showScreen('menu');
        return;
    }
    
    console.log('Showing payment screen with URL:', invoiceUrl);
    showScreen('payment');
    
    // Рисуем превью игрового поля после небольшой задержки, чтобы canvas был отрендерен
    setTimeout(() => {
        renderFieldPreview('field-preview');
    }, 100);
    
    // Сохраняем URL для оплаты в data-атрибут и устанавливаем обработчик
    const payBtn = document.getElementById('pay-btn');
    if (payBtn && invoiceUrl) {
        // Удаляем старый обработчик, если есть
        const newPayBtn = payBtn.cloneNode(true);
        payBtn.parentNode.replaceChild(newPayBtn, payBtn);
        
        // Устанавливаем новый обработчик
        newPayBtn.dataset.invoiceUrl = invoiceUrl;
        newPayBtn.addEventListener('click', function() {
            console.log('Pay button clicked, opening URL:', invoiceUrl);
            openPaymentUrl(invoiceUrl);
        });
    } else {
        console.error('Pay button not found or invoice URL missing');
        tg.showAlert('Ошибка: не удалось настроить кнопку оплаты');
    }
}

// Функция для открытия URL оплаты
function openPaymentUrl(url) {
    console.log('Opening payment URL:', url);
    
    if (!url || url === '#' || url === '') {
        tg.showAlert('Ошибка: неверный URL для оплаты');
        return;
    }
    
    try {
        // Проверяем, доступен ли tg.openLink
        if (typeof tg !== 'undefined' && tg.openLink) {
            console.log('Using tg.openLink');
            tg.openLink(url);
        } else {
            console.log('tg.openLink not available, using window.open');
            // Fallback: открываем в новом окне
            window.open(url, '_blank');
        }
    } catch (error) {
        console.error('Error opening payment link:', error);
        // Последняя попытка: пробуем открыть напрямую
        try {
            window.location.href = url;
        } catch (e) {
            tg.showAlert('Ошибка при открытии платежной системы: ' + error.message);
        }
    }
}

// Открытие платежа (legacy функция, теперь используется openPaymentUrl)
function openPayment() {
    const payBtn = document.getElementById('pay-btn');
    const invoiceUrl = payBtn?.dataset.invoiceUrl;
    
    if (!invoiceUrl) {
        tg.showAlert('Ошибка: URL для оплаты не найден');
        return;
    }
    
    openPaymentUrl(invoiceUrl);
}

// Проверка оплаты
async function checkPayment() {
    try {
        const baseUrl = window.location.origin;
        const response = await fetch(`${baseUrl}/api/game/check-payment`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
                body: JSON.stringify({
                    user_id: userId,  // Всегда используем userId из tg.initDataUnsafe.user.id
                    init_data: tg.initData || tg.initDataUnsafe || ''
                })
        });
        
        const data = await response.json();
        console.log('Check payment response:', data);
        
        if (data.paid) {
            // Показываем экран ожидания сразу после подтверждения оплаты
            showWaitingScreen();
            
            if (data.game_starting) {
                // Оба игрока оплатили - начинаем игру
                startCountdown(data.countdown || 5);
            } else {
                // Ждем второго игрока
                tg.showAlert('Оплата подтверждена! Ожидание соперника...');
            }
        } else {
            tg.showAlert('Оплата еще не подтверждена. Пожалуйста, оплатите счет.');
        }
    } catch (error) {
        console.error('Error checking payment:', error);
        tg.showAlert('Ошибка при проверке оплаты.');
    }
}

// Экран ожидания
function showWaitingScreen() {
    showScreen('waiting');
    // Рисуем превью игрового поля после небольшой задержки
    setTimeout(() => {
        renderFieldPreview('waiting-field');
    }, 100);
    
    // Периодическая проверка статуса (каждые 1 секунду для быстрого реагирования)
    const checkInterval = setInterval(async () => {
        try {
            const baseUrl = window.location.origin;
            const response = await fetch(`${baseUrl}/api/game/status`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    user_id: userId,  // Всегда используем userId из tg.initDataUnsafe.user.id
                    init_data: tg.initData || tg.initDataUnsafe || ''
                })
            });
            
            if (!response.ok) {
                console.error('Status check failed:', response.status);
                return;
            }
            
            const data = await response.json();
            console.log('Waiting screen polling status:', data);
            
            // Когда второй игрок подключился и матч создан, начинаем обратный отсчет
            if (data.status === 'ready_to_start' || data.game_starting) {
                clearInterval(checkInterval);
                console.log('Opponent connected! Starting countdown...', data);
                startCountdown(data.countdown || GAME_START_DELAY);
            }
        } catch (error) {
            console.error('Error checking status:', error);
        }
    }, 1000); // Проверяем каждую секунду для быстрого реагирования
}

// Обратный отсчет (синхронизированный с сервером)
function startCountdown(seconds = 5) {
    showScreen('countdown');
    // Рисуем превью игрового поля после небольшой задержки
    setTimeout(() => {
        renderFieldPreview('countdown-field');
    }, 100);
    
    // Создаем игру заранее для предварительной отрисовки
    if (!game) {
        game = new SnakeGame('game-canvas');
    }
    
    const countdownEl = document.getElementById('countdown-number');
    let count = seconds;
    
    countdownEl.textContent = count;
    
    // Периодически проверяем статус готовности на сервере
    const countdownInterval = setInterval(async () => {
        count--;
        if (count > 0) {
            countdownEl.textContent = count;
        } else {
            clearInterval(countdownInterval);
            // Проверяем статус на сервере перед стартом
            await checkServerStartStatus();
        }
    }, 1000);
}

// Проверка статуса старта на сервере (для синхронизации)
async function checkServerStartStatus() {
    try {
        const baseUrl = window.location.origin;
        const response = await fetch(`${baseUrl}/api/game/state`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
                body: JSON.stringify({
                    user_id: userId,  // Всегда используем userId из tg.initDataUnsafe.user.id
                    init_data: tg.initData || tg.initDataUnsafe || ''
                })
        });
        
        const data = await response.json();
        
        if (data.both_ready && data.game_start_timestamp) {
            gameStartTimestamp = data.game_start_timestamp;
            console.log(`Game start synchronized: ${gameStartTimestamp}`);
        }
        
        // Начинаем игру (даже если timestamp еще не установлен)
        startGamePlay();
    } catch (error) {
        console.error('Error checking server start status:', error);
        // Начинаем игру в любом случае
        startGamePlay();
    }
}

// Переменные для синхронизации
let gameSyncInterval = null;
let gameStateSyncInterval = null;
let gameStartTimestamp = null;
let lastSyncTime = 0;
let pendingDirectionChanges = []; // Очередь изменений направления для отправки
let directionSyncInProgress = false;
let networkErrorCount = 0;
let ghostOpponentPosition = null; // Ghost snake для плавности при сбоях сети
let gameEndCalled = false; // Флаг для предотвращения множественных вызовов endGame
let lastDirectionTime = {}; // Отслеживание времени последнего изменения направления (debounce)

// Начало игрового процесса
function startGamePlay() {
    showScreen('game');
    gameState = 'playing';
    lastSyncTime = Date.now();
    networkErrorCount = 0;
    pendingDirectionChanges = [];
    directionSyncInProgress = false;
    ghostOpponentPosition = null;
    
    // Создаем игру
    game = new SnakeGame('game-canvas');
    
    // POST REQUEST #1: Отправляем сигнал готовности на сервер (при старте игры)
    sendReadySignal();
    
    // WEBSOCKETS: Синхронізація оппонента тепер відбувається автоматично через WebSocket
    // listener для 'game_state' події (не потрібен окремий polling інтервал)
    
    // LOCAL VISUALS: Игровой цикл полностью на клиенте (client-side prediction)
    // Змейка двигается немедленно без ожидания сервера (нет fetch в draw loop)
    gameLoop = setInterval(() => {
        if (gameState === 'playing' && game) {
            // Проверяем, не наступило ли время старта (если есть timestamp)
            if (gameStartTimestamp) {
                const now = Date.now() / 1000;
                if (now < gameStartTimestamp) {
                    // Еще не время старта, только отрисовываем
                    game.draw();
                    return;
                }
            }
            
            // КЛИЕНТСКИЙ ЦИКЛ: Змейка двигается немедленно без ожидания сервера
            // НЕТ fetch вызовов здесь - только локальные update() и draw()
            game.update();
            game.draw();
            
            const state = game.getGameState();
            updatePlayerStatus(state);
            
            // POST REQUEST #2: Отправляем изменения направления (debounced, только при изменении)
            sendDirectionChangesIfAny();
            
            // Проверяем окончание игры (DEBOUNCED - только один раз)
            if (state.finished && !gameEndCalled) {
                gameEndCalled = true;
                // POST REQUEST #3: Отправляем окончание игры только один раз
                setTimeout(() => {
                    endGame();
                }, 0);
            }
        }
    }, 100); // 100ms = 10 ticks per second - полностью локальный цикл, нет fetch
    
    if (game) {
        game.draw();
    }
}

// WEBSOCKETS: Відправка сигналу готовності через WebSocket
function sendReadySignal() {
    // VALIDATION: Перевіряємо user_id перед відправкою
    if (!userId) {
        console.error('Cannot send ready signal: user_id is missing');
        return;
    }
    
    if (!socket || !socket.connected) {
        console.warn('WebSocket not connected, cannot send ready signal');
        return;
    }
    
    try {
        // WEBSOCKETS: Відправляємо сигнал готовності через WebSocket
        socket.emit('ready', {});
        console.log('Ready signal sent via WebSocket');
        }
    } catch (error) {
        console.error('Error sending ready signal via WebSocket:', error);
    }
}

// WEBSOCKETS: Ця функція більше не потрібна - синхронізація відбувається автоматично через WebSocket
// listener для 'game_state' події в initWebSocket()
// Видалено startOpponentSyncFrequent() - заміна на WebSocket real-time оновлення

// Завершение игры на основе данных сервера
function endGameFromServer(serverData) {
    // WEBSOCKETS: gameStateSyncInterval більше не потрібен - WebSocket listener автоматично обробляє оновлення
    // if (gameStateSyncInterval) {
    //     clearInterval(gameStateSyncInterval);
    //     gameStateSyncInterval = null;
    // }
    
    if (gameLoop) {
        clearInterval(gameLoop);
        gameLoop = null;
    }
    
    gameState = 'result';
    
    const isWinner = serverData.winner_id === userId;
    const prize = isWinner ? (GAME_PRICE_USD * 2 * 0.75) : 0;
    
    showResultScreen(isWinner ? 'player1' : 'player2', prize, false);
}

// Обработка направления (клиентское предсказание - змейка двигается немедленно)
function handleDirection(direction) {
    if (gameState !== 'playing' || !game) return;
    
    // Debounce: Предотвращаем слишком частые изменения направления (минимум 50ms между изменениями)
    const now = Date.now();
    const lastChangeTime = lastDirectionTime[direction] || 0;
    if (now - lastChangeTime < 50) {
        return; // Игнорируем слишком быстрые повторные нажатия той же клавиши
    }
    lastDirectionTime[direction] = now;
    
    // КЛИЕНТСКОЕ ПРЕДСКАЗАНИЕ: Змейка меняет направление немедленно (без ожидания сервера)
    // Функция setDirection уже имеет защиту от поворота на 180° (проверяет currentDir И nextDir)
    const directionChanged = game.setDirection('player1', direction);
    
    // Если направление не изменилось (например, попытка поворота на 180°), не отправляем на сервер
    if (directionChanged === false) {
        return;
    }
    
    // Добавляем в очередь для отправки на сервер (отправляем только изменения направления)
    pendingDirectionChanges.push({
        direction: direction,
        timestamp: Date.now()
    });
    
    // Отправляем изменение направления асинхронно (не блокируя игру)
    sendDirectionChangesIfAny();
}

// Отправка изменений направления на сервер (только изменения, не весь state)
async function sendDirectionChangesIfAny() {
    // Если уже идет отправка или нет изменений, пропускаем
    if (directionSyncInProgress || pendingDirectionChanges.length === 0) {
        return;
    }
    
    // Берем последнее изменение направления (игнорируем старые)
    const lastChange = pendingDirectionChanges[pendingDirectionChanges.length - 1];
    pendingDirectionChanges = []; // Очищаем очередь после отправки
    
    // Отправляем только последнее изменение направления
    await sendDirection(lastChange.direction);
}

// WEBSOCKETS: Відправка зміни напрямку через WebSocket
function sendDirection(direction) {
    // VALIDATION: Перевіряємо user_id (обов'язкове поле)
    if (!userId) {
        console.error('Cannot send direction: user_id is missing');
        directionSyncInProgress = false;
        return;
    }
    
    // VALIDATION: Перевіряємо direction
    if (!direction || typeof direction !== 'string') {
        console.error('Cannot send direction: direction is missing or not a string', direction);
        directionSyncInProgress = false;
        return;
    }
    
    // VALIDATION: Перевіряємо, що direction - це допустиме значення
    const validDirections = ['up', 'down', 'left', 'right'];
    const directionLower = direction.toLowerCase().trim();
    if (!validDirections.includes(directionLower)) {
        console.error('Cannot send direction: invalid direction value', direction, 'Valid values:', validDirections);
        directionSyncInProgress = false;
        return;
    }
    
    if (!socket || !socket.connected) {
        console.warn('WebSocket not connected, cannot send direction');
        directionSyncInProgress = false;
        return;
    }
    
    // Помічаємо, що йде відправка
    directionSyncInProgress = true;
    
    try {
        // WEBSOCKETS: Відправляємо напрямок через WebSocket
        // Синхронізація оппонента тепер відбувається автоматично через 'game_state' listener
        socket.emit('direction', {
            direction: directionLower
        });
        
        // Успішна відправка - скидаємо лічильник помилок
        if (typeof networkErrorCount !== 'undefined' && networkErrorCount > 0) {
            networkErrorCount = Math.max(0, networkErrorCount - 1);
        }
    } catch (error) {
        console.warn('Network error sending direction (game continues with client-side prediction):', error);
        // При помилці мережі гра продовжується на клієнті
        // Опонент продовжить рух на основі останньої синхронізованої позиції
    } finally {
        // Знімаємо прапорець після завершення (успішного або з помилкою)
        directionSyncInProgress = false;
    }
}

// Обновление статуса игроков
function updatePlayerStatus(state) {
    document.getElementById('player1-status').textContent = 
        `Вы: ${state.player1Alive ? 'Живы' : 'Мертвы'}`;
    document.getElementById('player2-status').textContent = 
        `Соперник: ${state.player2Alive ? 'Живы' : 'Мертвы'}`;
}

// POST REQUEST #3: Конец игры (DEBOUNCED - вызывается только один раз в конце игры)
async function endGame() {
    // Дополнительная проверка: если уже был вызов, не выполняем повторно
    if (gameEndCalled && gameState === 'result') {
        console.log('endGame already called, skipping duplicate call');
        return;
    }
    
    gameEndCalled = true;
    
    // Останавливаем игровой цикл (НЕТ gameStateSyncInterval, т.к. удалили startOpponentSync)
    if (gameLoop) {
        clearInterval(gameLoop);
        gameLoop = null;
    }
    
    gameState = 'result';
    
    const winner = game ? game.getWinner() : null;
    
    // VALIDATION: Проверяем user_id перед отправкой
    if (!userId) {
        console.error('Cannot end game: user_id is missing');
        showResultScreen(winner, null, false);
        return;
    }
    
    // DEBOUNCE API CALLS: Отправляем результат на сервер только один раз в конце игры
    // Не вызываем API во время игрового цикла, только при окончании
    try {
        const baseUrl = window.location.origin;
        const state = game ? game.getGameState() : { headToHeadCollision: false };
        // VALIDATION: Стандартизированные JSON ключи (должны совпадать с backend)
        const requestBody = {
            user_id: userId,  // Всегда отправляем user_id для изоляции пользователя
            winner: winner,
            headToHeadCollision: state.headToHeadCollision || false,
            init_data: tg.initData || tg.initDataUnsafe || ''
        };
        
        const response = await fetch(`${baseUrl}/api/game/end`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody)
        });
        
        const data = await response.json();
        showResultScreen(winner, data.prize, state.headToHeadCollision);
    } catch (error) {
        console.error('Error ending game:', error);
        showResultScreen(winner, null, false);
    }
}

// Экран результатов
function showResultScreen(winner, prize, headToHead = false) {
    showScreen('result');
    
    const resultCanvas = document.getElementById('result-canvas');
    if (!resultCanvas) {
        console.error('Result canvas not found');
        return;
    }
    
    if (resultCanvas.tagName !== 'CANVAS') {
        console.error('Result element is not a canvas');
        return;
    }
    
    const resultCtx = resultCanvas.getContext('2d');
    if (!resultCtx) {
        console.error('Could not get 2d context for result canvas');
        return;
    }
    
    resultCanvas.width = resultCanvas.offsetWidth;
    resultCanvas.height = resultCanvas.offsetWidth;
    game.ctx = resultCtx;
    game.canvas = resultCanvas;
    game.setupCanvas();
    game.draw();
    
    if (headToHead || winner === 'draw') {
        document.getElementById('result-icon').textContent = '💥';
        document.getElementById('result-title').textContent = 'Столкновение "лоб в лоб"!';
        document.getElementById('result-message').textContent = 'Оба игрока проиграли. Вся сумма уходит на комиссионный счет.';
        document.getElementById('result-prize').textContent = '';
    } else if (winner === 'player1') {
        document.getElementById('result-icon').textContent = '🏆';
        document.getElementById('result-title').textContent = 'Победа!';
        document.getElementById('result-message').textContent = 'Вы выиграли!';
        if (prize) {
            document.getElementById('result-prize').textContent = `💰 $${prize.toFixed(2)}`;
        }
    } else if (winner === 'player2') {
        document.getElementById('result-icon').textContent = '💔';
        document.getElementById('result-title').textContent = 'Поражение';
        document.getElementById('result-message').textContent = 'Вы проиграли';
        document.getElementById('result-prize').textContent = '';
    } else {
        document.getElementById('result-icon').textContent = '🤝';
        document.getElementById('result-title').textContent = 'Ничья';
        document.getElementById('result-message').textContent = 'Оба игрока проиграли';
        document.getElementById('result-prize').textContent = '';
    }
}

// Играть снова
function playAgain() {
    // Сброс состояния игры
    if (gameLoop) {
        clearInterval(gameLoop);
        gameLoop = null;
    }
    if (gameStateSyncInterval) {
        clearInterval(gameStateSyncInterval);
        gameStateSyncInterval = null;
    }
    game = null;
    gameState = 'menu';
    currentDirection = null;
    gameStartTimestamp = null;
    gameEndCalled = false; // Сброс флага для следующей игры
    lastDirectionTime = {}; // Сброс debounce таймеров
    pendingDirectionChanges = []; // Очистка очереди направлений
    networkErrorCount = 0;
    ghostOpponentPosition = null;
    
    // Игрок должен оплатить снова - показываем меню
    // При следующем нажатии "Играть" будет создан новый инвойс
    showScreen('menu');
}

// Закрыть игру
function closeGame() {
    tg.close();
}

// Рендер превью поля
function renderFieldPreview(canvasId) {
    const canvasElement = document.getElementById(canvasId);
    if (!canvasElement) {
        console.warn(`Canvas element with id '${canvasId}' not found`);
        return;
    }
    
    // Проверяем, что это canvas элемент
    if (canvasElement.tagName !== 'CANVAS') {
        console.warn(`Element with id '${canvasId}' is not a canvas element, it's a ${canvasElement.tagName}`);
        return;
    }
    
    try {
        const ctx = canvasElement.getContext('2d');
        if (!ctx) {
            console.warn(`Could not get 2d context for canvas '${canvasId}'`);
            return;
        }
        
        // Получаем размер после того, как элемент отрендерен
        const size = canvasElement.offsetWidth || 300;
        canvasElement.width = size;
        canvasElement.height = size;
        
        const gridSize = 20;
        const tileSize = size / gridSize;
        
        // Фон
        ctx.fillStyle = '#1e293b';
        ctx.fillRect(0, 0, size, size);
        
        // Границы
        ctx.strokeStyle = '#475569';
        ctx.lineWidth = 3;
        ctx.strokeRect(0, 0, size, size);
        
        // Сетка
        ctx.strokeStyle = '#475569';
        ctx.lineWidth = 1;
        for (let i = 0; i <= gridSize; i++) {
            ctx.beginPath();
            ctx.moveTo(i * tileSize, 0);
            ctx.lineTo(i * tileSize, size);
            ctx.stroke();
            
            ctx.beginPath();
            ctx.moveTo(0, i * tileSize);
            ctx.lineTo(size, i * tileSize);
            ctx.stroke();
        }
    } catch (error) {
        console.error(`Error rendering field preview for '${canvasId}':`, error);
    }
}

// Проверка состояния игры при загрузке
async function checkGameState() {
    try {
        // VALIDATION: Проверяем user_id (обязательное поле)
        if (!userId) {
            console.log('User ID not available for status check');
            return false;
        }
        
        const baseUrl = window.location.origin;
        // VALIDATION: Стандартизированные JSON ключи
        const requestBody = {
            user_id: userId,  // Всегда используем userId из tg.initDataUnsafe.user.id
            init_data: tg.initData || tg.initDataUnsafe || ''
        };
        
        // Створюємо AbortController для timeout (3 секунди)
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);
        
        const response = await fetch(`${baseUrl}/api/game/status`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            console.log('Status check failed:', response.status);
            return false;
        }
        
        const data = await response.json();
        console.log('Game status check:', data);
        
        if (data.status === 'payment_required') {
            // Игрок должен оплатить
            if (data.invoice_url) {
                console.log('Restoring payment screen with existing invoice');
                showPaymentScreen(data.invoice_url);
                return true; // Статус восстановлен
            }
        } else if (data.status === 'waiting_opponent' || data.status === 'waiting_opponent_payment') {
            // Игрок оплатил, ждет соперника
            console.log('Restoring waiting screen');
            showWaitingScreen();
            return true; // Статус восстановлен
        } else if (data.status === 'ready_to_start') {
            // Оба игрока готовы
            console.log('Game ready to start');
            startCountdown(GAME_START_DELAY);
            return true; // Статус восстановлен
        } else if (data.in_game && data.game_running) {
            // Игрок в активной игре
            console.log('Player is in active game');
            tg.showAlert('Вы уже в игре!');
            return true; // Статус восстановлен
        }
        
        return false; // Статус не восстановлен
    } catch (error) {
        if (error.name === 'AbortError') {
            console.warn('Game state check timeout');
        } else {
            console.error('Error checking game state:', error);
        }
        // Не критично, возвращаем false чтобы показать меню
        return false;
    }
}

