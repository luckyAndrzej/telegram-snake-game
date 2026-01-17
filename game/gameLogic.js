/**
 * Логика игры "Змейка"
 * Вся логика движения, столкновений и состояния игры
 */

const DIRECTIONS = {
  UP: { dx: 0, dy: -1 },
  DOWN: { dx: 0, dy: 1 },
  LEFT: { dx: -1, dy: 0 },
  RIGHT: { dx: 1, dy: 0 }
};

/**
 * Создать новую игру
 */
function createGame(player1Id, player2Id, config) {
  const gameId = `game_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  // Начальные позиции змеек
  const centerY = Math.floor(config.FIELD_HEIGHT / 2);
  const snake1Start = { x: 5, y: centerY };
  const snake2Start = { x: config.FIELD_WIDTH - 6, y: centerY };
  
  const game = {
    gameId,
    player1_id: player1Id,
    player2_id: player2Id,
    width: config.FIELD_WIDTH,
    height: config.FIELD_HEIGHT,
    
    // Состояние игры
    is_running: false,
    finished: false,
    start_time: null,
    end_time: null,
    winner_id: null,
    
    // Состояние змеек
    snake1: {
      body: createSnakeBody(snake1Start, 3),
      direction: DIRECTIONS.RIGHT,
      next_direction: DIRECTIONS.RIGHT,
      alive: true
    },
    snake2: {
      body: createSnakeBody(snake2Start, 3),
      direction: DIRECTIONS.LEFT,
      next_direction: DIRECTIONS.LEFT,
      alive: true
    },
    
    // Очередь команд
    pending_directions: {}, // userId -> direction
    
    // Готовность игроков
    player1_ready: false,
    player2_ready: false,
    
    // Тик игры
    tick_number: 0,
    last_tick_time: null
  };
  
  return game;
}

/**
 * Создать тело змейки
 */
function createSnakeBody(startPos, length) {
  const body = [{ ...startPos }];
  for (let i = 1; i < length; i++) {
    body.push({ x: startPos.x - i, y: startPos.y });
  }
  return body;
}

/**
 * Установить направление для игрока
 */
function setDirection(game, userId, directionStr) {
  const direction = DIRECTIONS[directionStr.toUpperCase()];
  if (!direction) {
    return; // Неверное направление
  }
  
  // Сохраняем команду в очередь (будет применена в следующем тике)
  game.pending_directions[userId] = direction;
}

/**
 * Выполнить один тик игры
 */
function tick(game) {
  if (game.finished || !game.is_running) {
    return { finished: game.finished, winner: game.winner_id };
  }
  
  // Применяем команды направлений из очереди
  if (game.pending_directions[game.player1_id]) {
    const newDir = game.pending_directions[game.player1_id];
    // Проверка на поворот на 180° (запрещено)
    if (!isOppositeDirection(game.snake1.direction, newDir)) {
      game.snake1.next_direction = newDir;
    }
    delete game.pending_directions[game.player1_id];
  }
  
  if (game.pending_directions[game.player2_id]) {
    const newDir = game.pending_directions[game.player2_id];
    if (!isOppositeDirection(game.snake2.direction, newDir)) {
      game.snake2.next_direction = newDir;
    }
    delete game.pending_directions[game.player2_id];
  }
  
  // Двигаем змейки
  moveSnake(game.snake1, game.width, game.height);
  moveSnake(game.snake2, game.width, game.height);
  
  // Проверяем столкновения
  checkCollisions(game);
  
  // Проверяем окончание игры
  if (!game.snake1.alive && !game.snake2.alive) {
    // Ничья
    game.finished = true;
    game.winner_id = null;
  } else if (!game.snake1.alive) {
    game.finished = true;
    game.winner_id = game.player2_id;
  } else if (!game.snake2.alive) {
    game.finished = true;
    game.winner_id = game.player1_id;
  }
  
  game.tick_number++;
  game.last_tick_time = Date.now();
  
  return {
    finished: game.finished,
    winner: game.winner_id
  };
}

/**
 * Движение змейки
 */
function moveSnake(snake, fieldWidth, fieldHeight) {
  if (!snake.alive) return;
  
  // Обновляем направление
  snake.direction = snake.next_direction;
  
  // Вычисляем новую позицию головы
  const head = snake.body[0];
  const newHead = {
    x: head.x + snake.direction.dx,
    y: head.y + snake.direction.dy
  };
  
  // Проверка границ поля
  if (newHead.x < 0 || newHead.x >= fieldWidth || 
      newHead.y < 0 || newHead.y >= fieldHeight) {
    snake.alive = false;
    return;
  }
  
  // Проверка столкновения с собой
  for (let i = 1; i < snake.body.length; i++) {
    if (newHead.x === snake.body[i].x && newHead.y === snake.body[i].y) {
      snake.alive = false;
      return;
    }
  }
  
  // Добавляем новую голову
  snake.body.unshift(newHead);
  // Удаляем хвост (змейка не растет)
  snake.body.pop();
}

/**
 * Проверка столкновений между змейками
 */
function checkCollisions(game) {
  const snake1 = game.snake1;
  const snake2 = game.snake2;
  
  if (!snake1.alive || !snake2.alive) return;
  
  const head1 = snake1.body[0];
  const head2 = snake2.body[0];
  
  // Проверка: голова змейки 1 ударилась о тело змейки 2
  for (let i = 1; i < snake2.body.length; i++) {
    if (head1.x === snake2.body[i].x && head1.y === snake2.body[i].y) {
      snake1.alive = false;
      return;
    }
  }
  
  // Проверка: голова змейки 2 ударилась о тело змейки 1
  for (let i = 1; i < snake1.body.length; i++) {
    if (head2.x === snake1.body[i].x && head2.y === snake1.body[i].y) {
      snake2.alive = false;
      return;
    }
  }
  
  // Проверка: лобовое столкновение голов
  if (head1.x === head2.x && head1.y === head2.y) {
    // Лобовое столкновение - обе змейки умирают (ничья)
    snake1.alive = false;
    snake2.alive = false;
  }
}

/**
 * Проверка на противоположное направление
 */
function isOppositeDirection(dir1, dir2) {
  return dir1.dx === -dir2.dx && dir1.dy === -dir2.dy && 
         dir1.dx !== 0 && dir1.dy !== 0;
}

/**
 * Получить снимок состояния игры для клиента
 */
function getGameSnapshot(game, userId) {
  const isPlayer1 = game.player1_id === userId;
  const mySnake = isPlayer1 ? game.snake1 : game.snake2;
  const opponentSnake = isPlayer1 ? game.snake2 : game.snake1;
  
  return {
    gameId: game.gameId,
    tick_number: game.tick_number,
    is_running: game.is_running,
    finished: game.finished,
    my_snake: {
      body: mySnake.body,
      alive: mySnake.alive,
      direction: mySnake.direction
    },
    opponent_snake: {
      body: opponentSnake.body,
      alive: opponentSnake.alive,
      direction: opponentSnake.direction
    },
    winner_id: game.winner_id
  };
}

module.exports = {
  createGame,
  setDirection,
  tick,
  getGameSnapshot
};

