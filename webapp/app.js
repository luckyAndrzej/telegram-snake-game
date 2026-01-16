// Telegram Web App интеграция
let tg = window.Telegram.WebApp;
let game = null;
let gameLoop = null;
let currentDirection = null;
let userData = null;
let gameState = 'menu'; // menu, payment, waiting, countdown, playing, result

// Константы
const GAME_START_DELAY = 5;

// Инициализация
document.addEventListener('DOMContentLoaded', async () => {
    tg.ready();
    tg.expand();
    
    // Получаем данные пользователя
    userData = tg.initDataUnsafe?.user;
    
    // Инициализируем игру
    initEventListeners();
    
    // Показываем загрузку
    showScreen('loading');
    
    // Проверяем состояние игры при загрузке
    const statusRestored = await checkGameState();
    
    // Если статус не восстановлен, показываем меню
    if (!statusRestored && (gameState === 'menu' || !document.getElementById('menu-screen')?.classList.contains('active'))) {
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
        
        // Проверяем, есть ли данные пользователя
        if (!userData || !userData.id) {
            console.error('User data not available:', userData);
            tg.showAlert('Ошибка: данные пользователя не найдены. Попробуйте перезагрузить приложение.');
            showScreen('menu');
            return;
        }
        
        const requestData = {
            user_id: userData.id,
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
        
        if (data.requires_payment) {
            if (data.invoice_url) {
                console.log('Showing payment screen with URL:', data.invoice_url);
                showPaymentScreen(data.invoice_url);
            } else {
                console.error('No invoice_url in response:', data);
                tg.showAlert('Ошибка: не получен URL для оплаты');
                showScreen('menu');
            }
        } else if (data.waiting) {
            console.log('Game waiting');
            showWaitingScreen();
        } else if (data.game_starting) {
            console.log('Game starting');
            startCountdown(data.countdown || 5);
        } else {
            console.error('Unknown game status:', data);
            tg.showAlert('Неизвестный статус игры');
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
                user_id: userData?.id,
                init_data: tg.initData
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
    
    // Периодическая проверка статуса
    const checkInterval = setInterval(async () => {
        try {
            const baseUrl = window.location.origin;
            const response = await fetch(`${baseUrl}/api/game/status`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    user_id: userData?.id,
                    init_data: tg.initData
                })
            });
            
            const data = await response.json();
            
            if (data.status === 'ready_to_start' || data.game_starting) {
                clearInterval(checkInterval);
                startCountdown(data.countdown || GAME_START_DELAY);
            }
        } catch (error) {
            console.error('Error checking status:', error);
        }
    }, 3000);
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
                user_id: userData?.id,
                init_data: tg.initData
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

// Начало игрового процесса
function startGamePlay() {
    showScreen('game');
    gameState = 'playing';
    
    // Создаем игру
    game = new SnakeGame('game-canvas');
    
    // Отправляем сигнал готовности на сервер
    sendReadySignal();
    
    // Запускаем синхронизацию состояния игры с сервером
    startGameStateSync();
    
    // Запускаем игровой цикл
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
            
            game.update();
            game.draw();
            
            const state = game.getGameState();
            updatePlayerStatus(state);
            
            // Отправляем направление на сервер
            if (currentDirection) {
                sendDirection(currentDirection);
                currentDirection = null;
            }
            
            // Проверяем окончание игры
            if (state.finished) {
                endGame();
            }
        }
    }, 100);
    
    if (game) {
        game.draw();
    }
}

// Отправка сигнала готовности
async function sendReadySignal() {
    try {
        const baseUrl = window.location.origin;
        const response = await fetch(`${baseUrl}/api/game/ready`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                user_id: userData?.id,
                init_data: tg.initData
            })
        });
        
        const data = await response.json();
        console.log('Ready signal response:', data);
        
        if (data.both_ready && data.game_start_timestamp) {
            gameStartTimestamp = data.game_start_timestamp;
            console.log(`Both players ready! Game starts at ${gameStartTimestamp}`);
        }
    } catch (error) {
        console.error('Error sending ready signal:', error);
    }
}

// Синхронизация состояния игры с сервером
function startGameStateSync() {
    if (gameStateSyncInterval) {
        clearInterval(gameStateSyncInterval);
    }
    
    gameStateSyncInterval = setInterval(async () => {
        try {
            const baseUrl = window.location.origin;
            const response = await fetch(`${baseUrl}/api/game/state`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    user_id: userData?.id,
                    init_data: tg.initData
                })
            });
            
            const data = await response.json();
            
            if (data.error) {
                console.error('Game state sync error:', data.error);
                return;
            }
            
            // Обновляем timestamp старта игры
            if (data.game_start_timestamp && !gameStartTimestamp) {
                gameStartTimestamp = data.game_start_timestamp;
            }
            
            // Синхронизируем позиции змеек с сервера
            if (game && data.my_snake && data.opponent_snake) {
                // Обновляем позицию оппонента из данных сервера
                if (data.opponent_snake.body) {
                    game.player2.body = data.opponent_snake.body.map(pos => ({x: pos[0], y: pos[1]}));
                    game.player2.alive = data.opponent_snake.alive;
                }
                
                // Обновляем свою позицию (если сервер считает иначе)
                if (data.my_snake.body) {
                    // Можно синхронизировать, но обычно клиент управляет своей змейкой
                    // game.player1.body = data.my_snake.body.map(pos => ({x: pos[0], y: pos[1]}));
                    game.player1.alive = data.my_snake.alive;
                }
            }
            
            // Проверяем окончание игры
            if (data.game_finished) {
                if (gameStateSyncInterval) {
                    clearInterval(gameStateSyncInterval);
                    gameStateSyncInterval = null;
                }
                if (gameLoop) {
                    clearInterval(gameLoop);
                    gameLoop = null;
                }
                endGameFromServer(data);
            }
        } catch (error) {
            console.error('Error syncing game state:', error);
        }
    }, 100); // Синхронизация каждые 100ms для плавности
}

// Завершение игры на основе данных сервера
function endGameFromServer(serverData) {
    if (gameStateSyncInterval) {
        clearInterval(gameStateSyncInterval);
        gameStateSyncInterval = null;
    }
    
    if (gameLoop) {
        clearInterval(gameLoop);
        gameLoop = null;
    }
    
    gameState = 'result';
    
    const isWinner = serverData.winner_id === userData?.id;
    const prize = isWinner ? (GAME_PRICE_USD * 2 * 0.75) : 0;
    
    showResultScreen(isWinner ? 'player1' : 'player2', prize, false);
}

// Обработка направления
function handleDirection(direction) {
    if (gameState !== 'playing' || !game) return;
    
    game.setDirection('player1', direction);
    currentDirection = direction;
    sendDirection(direction);
}

// Отправка направления на сервер
async function sendDirection(direction) {
    try {
        const baseUrl = window.location.origin;
        await fetch(`${baseUrl}/api/game/direction`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                user_id: userData?.id,
                direction: direction,
                init_data: tg.initData
            })
        });
    } catch (error) {
        console.error('Error sending direction:', error);
    }
}

// Обновление статуса игроков
function updatePlayerStatus(state) {
    document.getElementById('player1-status').textContent = 
        `Вы: ${state.player1Alive ? 'Живы' : 'Мертвы'}`;
    document.getElementById('player2-status').textContent = 
        `Соперник: ${state.player2Alive ? 'Живы' : 'Мертвы'}`;
}

// Конец игры
async function endGame() {
    // Останавливаем синхронизацию состояния
    if (gameStateSyncInterval) {
        clearInterval(gameStateSyncInterval);
        gameStateSyncInterval = null;
    }
    
    if (gameLoop) {
        clearInterval(gameLoop);
        gameLoop = null;
    }
    
    gameState = 'result';
    
    const winner = game.getWinner();
    
    // Отправляем результат на сервер
    try {
        const baseUrl = window.location.origin;
        const state = game.getGameState();
        const response = await fetch(`${baseUrl}/api/game/end`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                user_id: userData?.id,
                winner: winner,
                headToHeadCollision: state.headToHeadCollision || false,
                init_data: tg.initData
            })
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
        if (!userData || !userData.id) {
            console.log('User data not available for status check');
            return;
        }
        
        const baseUrl = window.location.origin;
        const response = await fetch(`${baseUrl}/api/game/status`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                user_id: userData.id,
                init_data: tg.initData
            })
        });
        
        if (!response.ok) {
            console.log('Status check failed:', response.status);
            return;
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
        console.error('Error checking game state:', error);
        // Не критично, продолжаем работу
    }
}

