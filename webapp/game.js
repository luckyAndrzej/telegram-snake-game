// Игровая логика змейки
class SnakeGame {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        if (!this.canvas) {
            throw new Error(`Canvas element with id '${canvasId}' not found`);
        }
        
        // Проверяем, что это canvas элемент
        if (this.canvas.tagName !== 'CANVAS') {
            throw new Error(`Element with id '${canvasId}' is not a canvas element`);
        }
        
        this.ctx = this.canvas.getContext('2d');
        if (!this.ctx) {
            throw new Error(`Could not get 2d context for canvas '${canvasId}'`);
        }
        
        this.gridSize = 20;
        this.headToHeadCollision = false;
        this.reset();
        this.setupCanvas();
        this.tileSize = Math.min(this.canvas.width, this.canvas.height) / this.gridSize;
    }

    setupCanvas() {
        const size = Math.min(window.innerWidth - 40, window.innerHeight - 300);
        this.canvas.width = size;
        this.canvas.height = size;
        this.tileSize = size / this.gridSize;
    }

    reset() {
        // СИНХРОНИЗАЦИЯ: Используем такую же длину, как на сервере (3 сегмента)
        // Начальные позиции будут синхронизированы с сервером через /api/game/status
        const centerY = Math.floor(this.gridSize / 2);
        this.player1 = {
            body: [
                {x: 5, y: centerY},
                {x: 4, y: centerY},
                {x: 3, y: centerY}
            ],
            direction: {x: 1, y: 0},
            nextDirection: {x: 1, y: 0},
            color: '#ef4444',
            alive: true
        };
        
        this.player2 = {
            body: [
                {x: 15, y: centerY},
                {x: 16, y: centerY},
                {x: 17, y: centerY}
            ],
            direction: {x: -1, y: 0},
            nextDirection: {x: -1, y: 0},
            color: '#3b82f6',
            alive: true
        };
    }
    
    // СИНХРОНИЗАЦИЯ: Обновление змеек с серверными данными (позиции и размеры)
    updateSnakesFromServer(snake1Data, snake2Data) {
        if (snake1Data && snake1Data.body) {
            this.player1.body = snake1Data.body.map(pos => ({x: pos[0], y: pos[1]}));
            this.player1.alive = snake1Data.alive !== false;
            // Синхронизируем направление, если оно есть
            if (snake1Data.direction) {
                if (Array.isArray(snake1Data.direction)) {
                    this.player1.direction = {x: snake1Data.direction[0], y: snake1Data.direction[1]};
                } else if (snake1Data.direction.x !== undefined) {
                    this.player1.direction = snake1Data.direction;
                }
            }
        }
        if (snake2Data && snake2Data.body) {
            this.player2.body = snake2Data.body.map(pos => ({x: pos[0], y: pos[1]}));
            this.player2.alive = snake2Data.alive !== false;
            // Синхронизируем направление, если оно есть
            if (snake2Data.direction) {
                if (Array.isArray(snake2Data.direction)) {
                    this.player2.direction = {x: snake2Data.direction[0], y: snake2Data.direction[1]};
                } else if (snake2Data.direction.x !== undefined) {
                    this.player2.direction = snake2Data.direction;
                }
            }
        }
    }

    setDirection(player, direction) {
        if (!this[player] || !this[player].alive) return;
        
        const dirMap = {
            up: {x: 0, y: -1},
            down: {x: 0, y: 1},
            left: {x: -1, y: 0},
            right: {x: 1, y: 0}
        };
        
        const newDir = dirMap[direction];
        if (!newDir) return;
        
        // АНТИ-180 ГРАДУСОВ: Проверяем против текущего И следующего направления
        // Это предотвращает поворот на 180° даже при быстрых нажатиях клавиш
        const currentDir = this[player].direction;
        const nextDir = this[player].nextDirection;
        
        // Проверяем против текущего направления
        const isOppositeToCurrent = (newDir.x === -currentDir.x && newDir.y === -currentDir.y);
        
        // Проверяем против следующего направления (чтобы предотвратить 180° через два быстрых нажатия)
        const isOppositeToNext = (newDir.x === -nextDir.x && newDir.y === -nextDir.y);
        
        // Нельзя повернуть в противоположную сторону ни к текущему, ни к следующему направлению
        if (isOppositeToCurrent || isOppositeToNext) {
            return false; // Возвращаем false, чтобы frontend знал, что изменение не применилось
        }
        
        // Разрешаем изменение направления
        this[player].nextDirection = newDir;
        return true; // Возвращаем true для успешного изменения
    }

    update() {
        // Обновляем направления
        this.player1.direction = this.player1.nextDirection;
        this.player2.direction = this.player2.nextDirection;
        
        // Двигаем змейки
        if (this.player1.alive) this.moveSnake('player1');
        if (this.player2.alive) this.moveSnake('player2');
        
        // Проверяем столкновения
        this.checkCollisions();
    }

    moveSnake(playerName) {
        const snake = this[playerName];
        const head = {...snake.body[0]};
        
        head.x += snake.direction.x;
        head.y += snake.direction.y;
        
        // Проверяем границы
        if (head.x < 0 || head.x >= this.gridSize || head.y < 0 || head.y >= this.gridSize) {
            snake.alive = false;
            return;
        }
        
        snake.body.unshift(head);
        snake.body.pop();
    }

    checkCollisions() {
        const p1 = this.player1;
        const p2 = this.player2;
        
        if (!p1.alive || !p2.alive) return;
        
        const p1Head = p1.body[0];
        const p2Head = p2.body[0];
        
        // Проверяем столкновение "лоб в лоб" (голова в голову)
        if (p1Head.x === p2Head.x && p1Head.y === p2Head.y) {
            p1.alive = false;
            p2.alive = false;
            this.headToHeadCollision = true;
            return;
        }
        
        // Проверяем столкновение player1 с телом player2
        for (let i = 0; i < p2.body.length; i++) {
            const segment = p2.body[i];
            if (p1Head.x === segment.x && p1Head.y === segment.y) {
                p1.alive = false;
                break;
            }
        }
        
        // Проверяем столкновение player2 с телом player1
        for (let i = 0; i < p1.body.length; i++) {
            const segment = p1.body[i];
            if (p2Head.x === segment.x && p2Head.y === segment.y) {
                p2.alive = false;
                break;
            }
        }
    }

    draw() {
        // Очищаем canvas
        this.ctx.fillStyle = '#1e293b';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        
        // Рисуем сетку
        this.ctx.strokeStyle = '#475569';
        this.ctx.lineWidth = 1;
        for (let i = 0; i <= this.gridSize; i++) {
            this.ctx.beginPath();
            this.ctx.moveTo(i * this.tileSize, 0);
            this.ctx.lineTo(i * this.tileSize, this.canvas.height);
            this.ctx.stroke();
            
            this.ctx.beginPath();
            this.ctx.moveTo(0, i * this.tileSize);
            this.ctx.lineTo(this.canvas.width, i * this.tileSize);
            this.ctx.stroke();
        }
        
        // Рисуем границы
        this.ctx.strokeStyle = '#475569';
        this.ctx.lineWidth = 3;
        this.ctx.strokeRect(0, 0, this.canvas.width, this.canvas.height);
        
        // Рисуем змейки
        if (this.player1.alive) this.drawSnake(this.player1);
        if (this.player2.alive) this.drawSnake(this.player2);
    }

    drawSnake(snake) {
        snake.body.forEach((segment, index) => {
            const x = segment.x * this.tileSize;
            const y = segment.y * this.tileSize;
            
            this.ctx.fillStyle = snake.color;
            
            if (index === 0) {
                // Голова
                this.ctx.fillRect(x + 2, y + 2, this.tileSize - 4, this.tileSize - 4);
                // Глаза
                this.ctx.fillStyle = 'white';
                const eyeSize = 3;
                const eyeOffset = 5;
                this.ctx.fillRect(x + eyeOffset, y + eyeOffset, eyeSize, eyeSize);
                this.ctx.fillRect(x + this.tileSize - eyeOffset - eyeSize, y + eyeOffset, eyeSize, eyeSize);
            } else {
                // Тело
                this.ctx.fillRect(x + 1, y + 1, this.tileSize - 2, this.tileSize - 2);
            }
        });
    }

    getGameState() {
        return {
            player1Alive: this.player1.alive,
            player2Alive: this.player2.alive,
            finished: !this.player1.alive || !this.player2.alive,
            headToHeadCollision: this.headToHeadCollision || false
        };
    }

    getWinner() {
        // Если столкновение "лоб в лоб", оба игрока проигрывают (draw)
        if (this.headToHeadCollision) return 'draw';
        if (!this.player1.alive && !this.player2.alive) return 'draw';
        if (!this.player1.alive) return 'player2';
        if (!this.player2.alive) return 'player1';
        return null;
    }
}

