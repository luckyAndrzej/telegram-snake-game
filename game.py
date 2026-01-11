"""
Модуль с логикой игры змейка
"""

from typing import List, Tuple, Optional, Dict
from enum import Enum
from config import GAME_FIELD_WIDTH, GAME_FIELD_HEIGHT, SNAKE_COLOR_PLAYER1, SNAKE_COLOR_PLAYER2
from logger import log_info, log_error


class Direction(Enum):
    """Направления движения змейки"""
    UP = (-1, 0)
    DOWN = (1, 0)
    LEFT = (0, -1)
    RIGHT = (0, 1)


class PlayerStatus(Enum):
    """Статус игрока"""
    WAITING = "ожидание"
    PAID = "оплачено"
    PLAYING = "играет"
    DEAD = "мертв"
    WON = "победил"


class Snake:
    """Класс змейки"""
    
    def __init__(self, player_id: int, start_pos: Tuple[int, int], color: str, initial_length: int = 3):
        self.player_id = player_id
        # Создаем змейку с начальной длиной
        self.body: List[Tuple[int, int]] = [start_pos]
        for i in range(1, initial_length):
            # Добавляем сегменты в противоположном направлении движения
            prev_pos = self.body[i - 1]
            self.body.append((prev_pos[0], prev_pos[1] - 1))
        self.direction = Direction.RIGHT
        self.next_direction = Direction.RIGHT
        self.color = color
        self.alive = True
        self.score = 0
    
    def move(self):
        """Двигает змейку в текущем направлении"""
        if not self.alive:
            return
        
        self.direction = self.next_direction
        dx, dy = self.direction.value
        
        # Вычисляем новую позицию головы
        head = self.body[0]
        new_head = (head[0] + dx, head[1] + dy)
        
        # Проверяем границы
        if (new_head[0] < 0 or new_head[0] >= GAME_FIELD_HEIGHT or
            new_head[1] < 0 or new_head[1] >= GAME_FIELD_WIDTH):
            self.alive = False
            log_info(f"Snake {self.player_id} hit boundary")
            return
        
        # Добавляем новую голову
        self.body.insert(0, new_head)
        
        # Удаляем хвост (змейка не растет)
        self.body.pop()
    
    def set_direction(self, direction: Direction):
        """Устанавливает направление движения"""
        # Нельзя повернуть в противоположную сторону
        opposite = {
            Direction.UP: Direction.DOWN,
            Direction.DOWN: Direction.UP,
            Direction.LEFT: Direction.RIGHT,
            Direction.RIGHT: Direction.LEFT
        }
        
        if direction != opposite.get(self.direction):
            self.next_direction = direction
    
    def check_collision(self, other_snake: 'Snake') -> bool:
        """Проверяет столкновение с другой змейкой"""
        if not self.alive or not other_snake.alive:
            return False
        
        head = self.body[0]
        
        # Проверяем столкновение головы с телом другой змейки
        for i, segment in enumerate(other_snake.body):
            if head == segment:
                # Столкновение с головой (боковая часть) или телом
                self.alive = False
                log_info(f"Snake {self.player_id} collided with snake {other_snake.player_id} at segment {i}")
                return True
        
        return False
    
    def get_head_char(self) -> str:
        """Возвращает символ для головы"""
        direction_chars = {
            Direction.UP: "⬆️",
            Direction.DOWN: "⬇️",
            Direction.LEFT: "⬅️",
            Direction.RIGHT: "➡️"
        }
        return direction_chars.get(self.direction, "●")
    
    def get_body_char(self) -> str:
        """Возвращает символ для тела"""
        return "●"


class Game:
    """Класс игры змейка"""
    
    def __init__(self, player1_id: int, player2_id: int):
        self.player1_id = player1_id
        self.player2_id = player2_id
        self.width = GAME_FIELD_WIDTH
        self.height = GAME_FIELD_HEIGHT
        self.is_running = False
        self.is_finished = False
        self.winner_id: Optional[int] = None
        
        # Создаем змейки в разных углах
        start_pos1 = (self.height // 4, self.width // 4)
        start_pos2 = (self.height * 3 // 4, self.width * 3 // 4)
        
        self.snake1 = Snake(player1_id, start_pos1, SNAKE_COLOR_PLAYER1)
        self.snake2 = Snake(player2_id, start_pos2, SNAKE_COLOR_PLAYER2)
        
        log_info(f"Game created: Player1 {player1_id} vs Player2 {player2_id}")
    
    def get_snake(self, player_id: int) -> Optional[Snake]:
        """Получает змейку игрока"""
        if player_id == self.player1_id:
            return self.snake1
        elif player_id == self.player2_id:
            return self.snake2
        return None
    
    def set_direction(self, player_id: int, direction: Direction):
        """Устанавливает направление для игрока"""
        snake = self.get_snake(player_id)
        if snake and snake.alive:
            snake.set_direction(direction)
    
    def update(self):
        """Обновляет состояние игры"""
        if not self.is_running or self.is_finished:
            return
        
        # Двигаем обе змейки
        self.snake1.move()
        self.snake2.move()
        
        # Проверяем столкновения
        if self.snake1.alive:
            self.snake1.check_collision(self.snake2)
        if self.snake2.alive:
            self.snake2.check_collision(self.snake1)
        
        # Проверяем окончание игры
        if not self.snake1.alive and not self.snake2.alive:
            # Ничья
            self.is_finished = True
            self.winner_id = None
            log_info("Game finished: Draw")
        elif not self.snake1.alive:
            self.is_finished = True
            self.winner_id = self.player2_id
            log_info(f"Game finished: Player {self.player2_id} won")
        elif not self.snake2.alive:
            self.is_finished = True
            self.winner_id = self.player1_id
            log_info(f"Game finished: Player {self.player1_id} won")
    
    def render_field(self) -> str:
        """Отрисовывает игровое поле"""
        # Создаем пустое поле
        field = [['⬜' for _ in range(self.width)] for _ in range(self.height)]
        
        # Добавляем границы
        for i in range(self.height):
            field[i][0] = '🟦'  # Левая граница
            field[i][self.width - 1] = '🟦'  # Правая граница
        for j in range(self.width):
            field[0][j] = '🟦'  # Верхняя граница
            field[self.height - 1][j] = '🟦'  # Нижняя граница
        
        # Рисуем змейку 1
        if self.snake1.alive:
            for i, pos in enumerate(self.snake1.body):
                # Проверяем границы массива
                if 0 <= pos[0] < self.height and 0 <= pos[1] < self.width:
                    if i == 0:
                        field[pos[0]][pos[1]] = self.snake1.color + '●'
                    else:
                        field[pos[0]][pos[1]] = self.snake1.color + '○'
        
        # Рисуем змейку 2
        if self.snake2.alive:
            for i, pos in enumerate(self.snake2.body):
                # Проверяем границы массива
                if 0 <= pos[0] < self.height and 0 <= pos[1] < self.width:
                    if i == 0:
                        field[pos[0]][pos[1]] = self.snake2.color + '●'
                    else:
                        field[pos[0]][pos[1]] = self.snake2.color + '○'
        
        # Преобразуем в строку
        lines = [''.join(row) for row in field]
        return '\n'.join(lines)
    
    def get_game_status_text(self) -> str:
        """Возвращает текстовый статус игры"""
        status = []
        
        # Статус змейки 1
        snake1_status = "жива" if self.snake1.alive else "мертва"
        status.append(f"Игрок 1 ({SNAKE_COLOR_PLAYER1}): {snake1_status}")
        
        # Статус змейки 2
        snake2_status = "жива" if self.snake2.alive else "мертва"
        status.append(f"Игрок 2 ({SNAKE_COLOR_PLAYER2}): {snake2_status}")
        
        if self.is_finished:
            if self.winner_id:
                status.append(f"Победитель: Игрок {1 if self.winner_id == self.player1_id else 2}")
            else:
                status.append("Ничья!")
        
        return '\n'.join(status)

