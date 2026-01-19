/**
 * Логика игры "Змейка"
 * Управление состоянием игры, движением змеек, коллизиями
 */

/**
 * Создание новой игры
 */
function createGame(player1Id, player2Id, config) {
  const FIELD_WIDTH = config.FIELD_WIDTH || 30;
  const FIELD_HEIGHT = config.FIELD_HEIGHT || 30;
  
  // Инициализация змеек
  // Игрок 1 (красная) - начинает слева, движется вправо
  // Начальная длина: 5 сегментов (было 3, добавлено 2)
  const snake1 = {
    body: [
      { x: 5, y: Math.floor(FIELD_HEIGHT / 2) },
      { x: 4, y: Math.floor(FIELD_HEIGHT / 2) },
      { x: 3, y: Math.floor(FIELD_HEIGHT / 2) },
      { x: 2, y: Math.floor(FIELD_HEIGHT / 2) },
      { x: 1, y: Math.floor(FIELD_HEIGHT / 2) }
    ],
    direction: { dx: 1, dy: 0 }, // Движется вправо
    alive: true,
    nextDirection: { dx: 1, dy: 0 }
  };
  
  // Игрок 2 (синяя) - начинает справа, движется влево
  // Начальная длина: 5 сегментов (было 3, добавлено 2)
  const snake2 = {
    body: [
      { x: FIELD_WIDTH - 6, y: Math.floor(FIELD_HEIGHT / 2) },
      { x: FIELD_WIDTH - 5, y: Math.floor(FIELD_HEIGHT / 2) },
      { x: FIELD_WIDTH - 4, y: Math.floor(FIELD_HEIGHT / 2) },
      { x: FIELD_WIDTH - 3, y: Math.floor(FIELD_HEIGHT / 2) },
      { x: FIELD_WIDTH - 2, y: Math.floor(FIELD_HEIGHT / 2) }
    ],
    direction: { dx: -1, dy: 0 }, // Движется влево
    alive: true,
    nextDirection: { dx: -1, dy: 0 }
  };
  
  return {
    gameId: `game_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    player1_id: player1Id,
    player2_id: player2Id,
    snake1: snake1,
    snake2: snake2,
    is_running: false,
    finished: false,
    winner_id: null,
    tick_number: 0,
    start_time: null,
    end_time: null,
    FIELD_WIDTH: FIELD_WIDTH,
    FIELD_HEIGHT: FIELD_HEIGHT
  };
}

/**
 * Выполнение одного тика игры (обновление состояния)
 */
function tick(game) {
  if (game.finished || !game.is_running) {
    return { finished: game.finished, winner: game.winner_id };
  }
  
  game.tick_number++;
  
  // Обновляем направления змеек (применяем nextDirection)
  if (game.snake1.alive) {
    game.snake1.direction = { ...game.snake1.nextDirection };
  }
  if (game.snake2.alive) {
    game.snake2.direction = { ...game.snake2.nextDirection };
  }
  
  // Двигаем змейки
  if (game.snake1.alive) {
    moveSnake(game.snake1, game.FIELD_WIDTH, game.FIELD_HEIGHT);
  }
  if (game.snake2.alive) {
    moveSnake(game.snake2, game.FIELD_WIDTH, game.FIELD_HEIGHT);
  }
  
  // Проверяем коллизии
  checkCollisions(game);
  
  // Проверяем, завершена ли игра
  if (!game.snake1.alive && !game.snake2.alive) {
    // Ничья - оба погибли
    game.finished = true;
    game.winner_id = null;
    return { finished: true, winner: null };
  } else if (!game.snake1.alive) {
    // Игрок 2 победил
    game.finished = true;
    game.winner_id = game.player2_id;
    return { finished: true, winner: game.player2_id };
  } else if (!game.snake2.alive) {
    // Игрок 1 победил
    game.finished = true;
    game.winner_id = game.player1_id;
    return { finished: true, winner: game.player1_id };
  }
  
  return { finished: false, winner: null };
}

/**
 * Движение змейки
 */
function moveSnake(snake, fieldWidth, fieldHeight) {
  if (!snake.alive || !snake.body || snake.body.length === 0) return;
  
  const head = snake.body[0];
  const newHead = {
    x: head.x + snake.direction.dx,
    y: head.y + snake.direction.dy
  };
  
  // Добавляем новую голову
  snake.body.unshift(newHead);
  
  // Удаляем хвост (змейка не растет автоматически)
  snake.body.pop();
}

/**
 * Проверка коллизий
 */
function checkCollisions(game) {
  // Проверка столкновения с границами поля
  if (game.snake1.alive) {
    const head1 = game.snake1.body[0];
    if (head1.x < 0 || head1.x >= game.FIELD_WIDTH || 
        head1.y < 0 || head1.y >= game.FIELD_HEIGHT) {
      game.snake1.alive = false;
    }
  }
  
  if (game.snake2.alive) {
    const head2 = game.snake2.body[0];
    if (head2.x < 0 || head2.x >= game.FIELD_WIDTH || 
        head2.y < 0 || head2.y >= game.FIELD_HEIGHT) {
      game.snake2.alive = false;
    }
  }
  
  // Проверка столкновения с собственным телом
  if (game.snake1.alive) {
    const head1 = game.snake1.body[0];
    for (let i = 1; i < game.snake1.body.length; i++) {
      if (game.snake1.body[i].x === head1.x && game.snake1.body[i].y === head1.y) {
        game.snake1.alive = false;
        break;
      }
    }
  }
  
  if (game.snake2.alive) {
    const head2 = game.snake2.body[0];
    for (let i = 1; i < game.snake2.body.length; i++) {
      if (game.snake2.body[i].x === head2.x && game.snake2.body[i].y === head2.y) {
        game.snake2.alive = false;
        break;
      }
    }
  }
  
  // Проверка столкновения змеек друг с другом
  if (game.snake1.alive && game.snake2.alive) {
    const head1 = game.snake1.body[0];
    const head2 = game.snake2.body[0];
    
    // Лобовое столкновение голов
    if (head1.x === head2.x && head1.y === head2.y) {
      game.snake1.alive = false;
      game.snake2.alive = false;
      return; // Ничья
    }
    
    // Проверка столкновения головы одной змейки с телом другой
    for (let i = 1; i < game.snake2.body.length; i++) {
      if (game.snake2.body[i].x === head1.x && game.snake2.body[i].y === head1.y) {
        game.snake1.alive = false;
        break;
      }
    }
    
    for (let i = 1; i < game.snake1.body.length; i++) {
      if (game.snake1.body[i].x === head2.x && game.snake1.body[i].y === head2.y) {
        game.snake2.alive = false;
        break;
      }
    }
  }
}

/**
 * Установка направления змейки
 */
function setDirection(game, userId, direction) {
  const isPlayer1 = game.player1_id === userId;
  const snake = isPlayer1 ? game.snake1 : game.snake2;
  
  if (!snake || !snake.alive) return;
  
  // Преобразуем строку направления в объект
  const directionMap = {
    'up': { dx: 0, dy: -1 },
    'down': { dx: 0, dy: 1 },
    'left': { dx: -1, dy: 0 },
    'right': { dx: 1, dy: 0 }
  };
  
  const newDirection = directionMap[direction.toLowerCase()];
  if (!newDirection) return;
  
  // Проверка на поворот на 180° (запрещено)
  const currentDir = snake.direction;
  if (currentDir.dx === -newDirection.dx && currentDir.dy === -newDirection.dy &&
      currentDir.dx !== 0 && currentDir.dy !== 0) {
    return; // Запрещаем поворот на 180°
  }
  
  // Сохраняем направление для следующего тика
  snake.nextDirection = newDirection;
}

/**
 * Получение снимка состояния игры для конкретного игрока
 */
function getGameSnapshot(game, userId) {
  const isPlayer1 = game.player1_id === userId;
  
  return {
    gameId: game.gameId,
    tick_number: game.tick_number,
    my_snake: {
      body: isPlayer1 ? [...game.snake1.body] : [...game.snake2.body],
      alive: isPlayer1 ? game.snake1.alive : game.snake2.alive,
      direction: isPlayer1 ? { ...game.snake1.direction } : { ...game.snake2.direction }
    },
    opponent_snake: {
      body: isPlayer1 ? [...game.snake2.body] : [...game.snake1.body],
      alive: isPlayer1 ? game.snake2.alive : game.snake1.alive,
      direction: isPlayer1 ? { ...game.snake2.direction } : { ...game.snake1.direction }
    },
    finished: game.finished,
    winner_id: game.winner_id
  };
}

module.exports = {
  createGame,
  tick,
  setDirection,
  getGameSnapshot
};

