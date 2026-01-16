"""
API эндпоинты для веб-приложения Telegram Mini App
"""

from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from flask_socketio import SocketIO, emit, join_room, leave_room, disconnect
import os
from typing import Dict, Optional
import hmac
import hashlib
import json
import random

from config import TELEGRAM_BOT_TOKEN, GAME_PRICE_USD, GAME_START_DELAY, OWNER_ID, OWNER_PERCENTAGE, WINNER_PERCENTAGE
from game import Game, Direction
from payment import crypto_pay
from logger import log_info, log_error
from game_loop import start_game_tick_loop, is_game_loop_running, game_tick_loop
import threading
import time
import atexit

# Импортируем глобальные переменные из main.py
# В реальном проекте лучше использовать Redis или базу данных
import main as game_main

# USER ISOLATION: Словарь для изоляции игр по user_id
# Каждый user_id имеет доступ только к своей игре через game_id
user_games: Dict[int, int] = {}  # user_id -> game_id (изоляция пользователей)

# Блокировка для атомарного создания матча
matchmaking_lock = threading.Lock()

# Используем функцию get_game_id из main.py для консистентности
# (но для webapp_api она должна работать синхронно)
def get_game_id_webapp():
    """Генерирует уникальный ID игры (синхронная версия для webapp_api)"""
    game_main.game_counter += 1
    return game_main.game_counter

def create_game_match(player1_id: int, player2_id: int):
    """Создает матч между двумя игроками (атомарно)"""
    with matchmaking_lock:
        # Дополнительная проверка - убеждаемся, что игроки еще в waiting_players и не в другой игре
        if player1_id not in game_main.waiting_players or player2_id not in game_main.waiting_players:
            log_info(f"Cannot create match: players not in waiting_players. Player1: {player1_id in game_main.waiting_players}, Player2: {player2_id in game_main.waiting_players}")
            return None
        
        if player1_id in game_main.player_to_game or player2_id in game_main.player_to_game:
            log_info(f"Cannot create match: one or both players already in a game. Player1: {player1_id in game_main.player_to_game}, Player2: {player2_id in game_main.player_to_game}")
            return None
        
        # PAYMENT DISABLED: Проверка оплаты отключена временно
        # Игроки сразу добавляются в матчмейкинг без оплаты
        player1_data = game_main.waiting_players[player1_id]
        player2_data = game_main.waiting_players[player2_id]
        
        # Создаем игру
        game = Game(player1_id, player2_id)
        game_id = get_game_id_webapp()
        game_main.active_games[game_id] = game
        game_main.player_to_game[player1_id] = game_id
        game_main.player_to_game[player2_id] = game_id
        
        # USER ISOLATION: Сохраняем связь user_id -> game_id для изоляции пользователей
        user_games[player1_id] = game_id
        user_games[player2_id] = game_id
        
        # Удаляем из ожидающих
        if player1_id in game_main.waiting_players:
            del game_main.waiting_players[player1_id]
        if player2_id in game_main.waiting_players:
            del game_main.waiting_players[player2_id]
        
        # СИСТЕМА ТИКОВ: Убеждаемся, что игровой цикл запущен
        # (он запускается автоматически при импорте модуля, но проверяем для надежности)
        if not is_game_loop_running():
            _start_game_loop_thread()
        
        log_info(f"Game {game_id} created: Player1 {player1_id} vs Player2 {player2_id}")
        return game_id

app = Flask(__name__, static_folder='webapp')
CORS(app)

# WEBSOCKETS: Инициализация SocketIO для real-time обновлений
# Используем async_mode='threading' для совместимости с Flask
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading', logger=True, engineio_logger=True)

# WEBSOCKETS: Словарь для отслеживания подключений игроков
# Ключ: user_id, Значение: session_id (SocketIO session ID)
player_connections: Dict[int, str] = {}  # user_id -> session_id
session_to_user: Dict[str, int] = {}  # session_id -> user_id (обратная связь)
game_rooms: Dict[int, list] = {}  # game_id -> [user_id1, user_id2] (игроки в игре)

# СИСТЕМА ТИКОВ: Инициализация игрового цикла при старте приложения
# Запускаем игровой цикл в отдельном потоке при первом импорте модуля
_game_loop_thread_started = False
_game_loop_thread = None

def _start_game_loop_thread():
    """Запускает игровой цикл в отдельном потоке (для Flask синхронного приложения)"""
    global _game_loop_thread_started, _game_loop_thread
    
    if _game_loop_thread_started:
        return
    
    import threading
    import asyncio
    
    def run_game_loop():
        """Запускает asyncio event loop в отдельном потоке"""
        # Создаем новый event loop для этого потока
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        try:
            # Запускаем игровой цикл тиков напрямую с callback для WebSocket broadcast
            # game_tick_loop - это бесконечная корутина, которую нужно запустить в event loop
            loop.run_until_complete(game_tick_loop(game_main.active_games, broadcast_game_state))
        except Exception as e:
            log_error("_start_game_loop_thread", e)
            import traceback
            log_info(f"Traceback: {traceback.format_exc()}")
        finally:
            try:
                # Отменяем все задачи перед закрытием
                pending = asyncio.all_tasks(loop)
                for task in pending:
                    task.cancel()
                loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
            except Exception:
                pass
            loop.close()
    
    _game_loop_thread = threading.Thread(target=run_game_loop, daemon=True, name="GameTickLoop")
    _game_loop_thread.start()
    _game_loop_thread_started = True
    log_info("Game tick loop thread started")

# Автоматически запускаем игровой цикл при импорте модуля
_start_game_loop_thread()

# Регистрируем остановку игрового цикла при завершении приложения
atexit.register(lambda: log_info("Application shutting down, game loop will stop"))

# Валидация initData от Telegram
def validate_init_data(init_data: str) -> Optional[Dict]:
    """Валидирует initData от Telegram Web App"""
    try:
        from urllib.parse import parse_qs, unquote
        
        # Парсим init_data
        parsed = parse_qs(init_data)
        hash_value = parsed.get('hash', [None])[0]
        
        if not hash_value:
            return None
        
        # Создаем секретный ключ
        secret_key = hmac.new(
            b"WebAppData",
            TELEGRAM_BOT_TOKEN.encode(),
            hashlib.sha256
        ).digest()
        
        # Создаем data_check_string
        data_check_string = '\n'.join(
            f"{key}={value[0]}"
            for key, value in sorted(parsed.items())
            if key != 'hash'
        )
        
        # Проверяем подпись
        calculated_hash = hmac.new(
            secret_key,
            data_check_string.encode(),
            hashlib.sha256
        ).hexdigest()
        
        if calculated_hash != hash_value:
            return None
        
        # Парсим user
        user_str = parsed.get('user', [None])[0]
        if user_str:
            user = json.loads(unquote(user_str))
            return user
        
        return None
    except Exception as e:
        log_error("validate_init_data", e)
        return None


# WEBSOCKETS: Обработчики событий WebSocket для real-time обновлений
@socketio.on('connect')
def handle_connect(auth):
    """Обработчик подключения игрока через WebSocket"""
    try:
        # Получаем user_id из auth данных (передается при подключении)
        if not auth or 'user_id' not in auth:
            log_error("handle_connect", Exception("Missing user_id in auth data"))
            disconnect()
            return False
        
        user_id = int(auth['user_id'])
        session_id = request.sid
        
        # Сохраняем связь user_id -> session_id
        player_connections[user_id] = session_id
        session_to_user[session_id] = user_id
        
        log_info(f"WebSocket connected: user_id={user_id}, session_id={session_id}")
        
        # Если игрок уже в игре, добавляем его в комнату игры
        if user_id in game_main.player_to_game:
            game_id = game_main.player_to_game[user_id]
            room_name = f"game_{game_id}"
            join_room(room_name)
            
            if game_id not in game_rooms:
                game_rooms[game_id] = []
            if user_id not in game_rooms[game_id]:
                game_rooms[game_id].append(user_id)
            
            log_info(f"Player {user_id} joined game room {room_name}")
            
            # Отправляем текущее состояние игры новому подключению
            if game_id in game_main.active_games:
                game = game_main.active_games[game_id]
                snapshot = game.get_snapshot()
                snapshot['user_id'] = user_id
                emit('game_state', snapshot, room=session_id)
        
        return True
    
    except Exception as e:
        log_error("handle_connect", e)
        disconnect()
        return False


@socketio.on('disconnect')
def handle_disconnect():
    """Обработчик отключения игрока через WebSocket"""
    try:
        session_id = request.sid
        
        if session_id in session_to_user:
            user_id = session_to_user[session_id]
            
            # Удаляем связь
            if user_id in player_connections:
                del player_connections[user_id]
            del session_to_user[session_id]
            
            # Удаляем из комнат игр
            if user_id in game_main.player_to_game:
                game_id = game_main.player_to_game[user_id]
                room_name = f"game_{game_id}"
                leave_room(room_name)
                
                if game_id in game_rooms and user_id in game_rooms[game_id]:
                    game_rooms[game_id].remove(user_id)
            
            log_info(f"WebSocket disconnected: user_id={user_id}, session_id={session_id}")
    
    except Exception as e:
        log_error("handle_disconnect", e)


@socketio.on('direction')
def handle_direction(data):
    """Обработчик получения направления от игрока через WebSocket"""
    try:
        session_id = request.sid
        
        if session_id not in session_to_user:
            emit('error', {'message': 'Not authenticated'})
            return
        
        user_id = session_to_user[session_id]
        direction_str = data.get('direction')
        
        if not direction_str:
            emit('error', {'message': 'Direction required'})
            return
        
        if user_id not in game_main.player_to_game:
            emit('error', {'message': 'Not in game'})
            return
        
        game_id = game_main.player_to_game[user_id]
        if game_id not in game_main.active_games:
            emit('error', {'message': 'Game not found'})
            return
        
        game = game_main.active_games[game_id]
        
        if game.is_finished:
            emit('error', {'message': 'Game finished'})
            return
        
        # Преобразуем строку в Direction
        direction_map = {
            "up": Direction.UP,
            "down": Direction.DOWN,
            "left": Direction.LEFT,
            "right": Direction.RIGHT
        }
        
        direction_str = direction_str.lower().strip()
        direction = direction_map.get(direction_str)
        
        if not direction:
            emit('error', {'message': f'Invalid direction: {direction_str}'})
            return
        
        # Сохраняем направление в очередь для следующего тика
        command_timestamp = time.time()
        game.queue_direction(user_id, direction, command_timestamp)
        
        log_info(f"WebSocket direction queued for user {user_id} in game {game_id}: {direction_str}")
        
        # Подтверждение команды
        emit('direction_queued', {
            'success': True,
            'direction': direction_str,
            'tick_number': game.tick_number
        })
    
    except Exception as e:
        log_error("handle_direction", e)
        emit('error', {'message': str(e)})


@socketio.on('ready')
def handle_ready(data):
    """Обработчик сигнала готовности игрока через WebSocket"""
    try:
        session_id = request.sid
        
        if session_id not in session_to_user:
            emit('error', {'message': 'Not authenticated'})
            return
        
        user_id = session_to_user[session_id]
        
        if user_id not in game_main.player_to_game:
            emit('error', {'message': 'Not in game'})
            return
        
        game_id = game_main.player_to_game[user_id]
        if game_id not in game_main.active_games:
            emit('error', {'message': 'Game not found'})
            return
        
        game = game_main.active_games[game_id]
        
        # Устанавливаем готовность игрока
        if user_id == game.player1_id:
            game.player1_ready = True
            log_info(f"Player 1 ({user_id}) is ready for game {game_id}")
        elif user_id == game.player2_id:
            game.player2_ready = True
            log_info(f"Player 2 ({user_id}) is ready for game {game_id}")
        
        # Проверяем, готовы ли оба игрока
        if game.player1_ready and game.player2_ready:
            # Устанавливаем время начала игры (для синхронизации countdown)
            if game.game_start_timestamp is None:
                game.game_start_timestamp = time.time()
                log_info(f"Both players ready! Game {game_id} will start after countdown at timestamp {game.game_start_timestamp}")
            
            # Отправляем событие начала игры в комнату игры
            room_name = f"game_{game_id}"
            emit('both_ready', {
                'game_id': game_id,
                'game_start_timestamp': game.game_start_timestamp,
                'countdown_seconds': GAME_START_DELAY
            }, room=room_name, broadcast=True)
        
        # Подтверждение готовности
        emit('ready_confirmed', {
            'player1_ready': game.player1_ready,
            'player2_ready': game.player2_ready
        })
    
    except Exception as e:
        log_error("handle_ready", e)
        emit('error', {'message': str(e)})


# WEBSOCKETS: Функция для broadcast игрового состояния всем игрокам в игре
def broadcast_game_state(game_id: int):
    """Отправляет текущее состояние игры всем игрокам через WebSocket"""
    try:
        if game_id not in game_main.active_games:
            return
        
        game = game_main.active_games[game_id]
        base_snapshot = game.get_snapshot()
        room_name = f"game_{game_id}"
        
        # Отправляем персональные данные каждому игроку (my_snake и opponent_snake)
        # Игрок 1
        if game.player1_id in player_connections:
            snapshot_p1 = base_snapshot.copy()
            snapshot_p1['my_snake'] = snapshot_p1['snake1']
            snapshot_p1['opponent_snake'] = snapshot_p1['snake2']
            socketio.emit('game_state', snapshot_p1, room=player_connections[game.player1_id])
        
        # Игрок 2
        if game.player2_id in player_connections:
            snapshot_p2 = base_snapshot.copy()
            snapshot_p2['my_snake'] = snapshot_p2['snake2']
            snapshot_p2['opponent_snake'] = snapshot_p2['snake1']
            socketio.emit('game_state', snapshot_p2, room=player_connections[game.player2_id])
    
    except Exception as e:
        log_error(f"broadcast_game_state_{game_id}", e)


@app.route('/webapp/<path:filename>')
def serve_static(filename):
    """Раздача статических файлов веб-приложения"""
    return send_from_directory('webapp', filename)


@app.route('/webapp/')
def serve_index():
    """Главная страница веб-приложения"""
    return send_from_directory('webapp', 'index.html')


@app.route('/api/game/status', methods=['POST'])
def api_game_status():
    """API для проверки статуса игрока при загрузке"""
    try:
        data = request.json
        user_id = data.get('user_id')
        
        if not user_id:
            return jsonify({'error': 'User ID required'}), 400
        
        # Проверяем, находится ли игрок в активной игре
        # КРИТИЧНО: Проверяем player_to_game ПЕРВЫМ, чтобы первый игрок видел матч сразу после создания
        if user_id in game_main.player_to_game:
            game_id = game_main.player_to_game[user_id]
            if game_id in game_main.active_games:
                game = game_main.active_games[game_id]
                # Если игра создана, но еще не запущена (COUNTDOWN) - оба игрока подключены
                if not game.is_running and not game.is_finished:
                    return jsonify({
                        'status': 'ready_to_start',
                        'game_starting': True,
                        'countdown': GAME_START_DELAY,
                        'paid': True,
                        'message': 'Оба игрока готовы, игра скоро начнется'
                    })
                # Если игра идет
                elif game.is_running and not game.is_finished:
                    return jsonify({
                        'in_game': True,
                        'game_running': True,
                        'status': 'playing'
                    })
                # Если игра завершена
                else:
                    return jsonify({
                        'in_game': True,
                        'game_running': False,
                        'game_finished': True,
                        'status': 'finished'
                    })
        
        # Проверяем, есть ли ожидающий игрок (включая текущего)
        # PAYMENT DISABLED: Проверка оплаты отключена временно
        if user_id in game_main.waiting_players:
            player_data = game_main.waiting_players[user_id]
            
            # Проверяем, есть ли второй игрок
            other_waiting = [uid for uid in game_main.waiting_players.keys() if uid != user_id]
            if other_waiting:
                opponent_id = other_waiting[0]
                # Оба игрока в очереди - создаем игру автоматически
                game_id = create_game_match(user_id, opponent_id)
                if game_id:
                    log_info(f"Game {game_id} created automatically when both players in queue")
                    return jsonify({
                        'status': 'ready_to_start',
                        'paid': True,
                        'game_starting': True,
                        'countdown': GAME_START_DELAY,
                        'message': 'Оба игрока готовы, игра скоро начнется'
                    })
                else:
                    # Игра не создана (возможно, уже создана или игроки в другой игре)
                    # Проверяем, может быть игрок уже в игре
                    if user_id in game_main.player_to_game:
                        game_id = game_main.player_to_game[user_id]
                        if game_id in game_main.active_games:
                            return jsonify({
                                'status': 'ready_to_start',
                                'paid': True,
                                'game_starting': True,
                                'countdown': GAME_START_DELAY,
                                'message': 'Игра создана, готовимся к старту'
                            })
                    return jsonify({
                        'status': 'ready_to_start',
                        'paid': True,
                        'message': 'Оба игрока готовы, игра скоро начнется'
                    })
            else:
                return jsonify({
                    'status': 'waiting_opponent',
                    'paid': True,
                    'message': 'Ожидание второго игрока'
                })
        
        return jsonify({
            'status': 'no_game',
            'paid': False,
            'message': 'Нет активной игры'
        })
        
    except Exception as e:
        log_error("api_game_status", e)
        return jsonify({'error': 'Internal server error'}), 500


@app.route('/api/game/start', methods=['POST'])
def api_start_game():
    """API для начала игры"""
    try:
        log_info("API /api/game/start called")
        data = request.json
        log_info(f"Request data: {data}")
        
        if not data:
            log_error("api_start_game", Exception("No JSON data in request"))
            return jsonify({'error': 'No data received'}), 400
        
        user_id = data.get('user_id')
        init_data = data.get('init_data')
        
        log_info(f"User ID: {user_id}")
        
        if not user_id:
            log_error("api_start_game", Exception("User ID not provided"))
            return jsonify({'error': 'User ID required'}), 400
        
        # Валидируем init_data (в продакшене)
        # user = validate_init_data(init_data)
        
        # Проверяем, не находится ли игрок уже в игре
        # Если игрок уже в активной игре (игра идет), возвращаем статус игры
        if user_id in game_main.player_to_game:
            game_id = game_main.player_to_game[user_id]
            if game_id in game_main.active_games:
                game = game_main.active_games[game_id]
                if game.is_running and not game.is_finished:
                    # Игра уже идет
                    return jsonify({
                        'in_game': True,
                        'game_running': True,
                        'status': 'playing'
                    })
                elif not game.is_running and not game.is_finished:
                    # Игра создана, но еще не началась (COUNTDOWN) - оба игрока подключены
                    return jsonify({
                        'status': 'ready_to_start',
                        'game_starting': True,
                        'countdown': GAME_START_DELAY,
                        'message': 'Оба игрока готовы, игра скоро начнется'
                    })
        
        # PAYMENT DISABLED: Оплата отключена временно
        # Игрок сразу добавляется в матчмейкинг без оплаты
        
        # ИСПРАВЛЕННАЯ ЛОГИКА МАТЧМЕЙКИНГА:
        # 1. Если игрок уже в игре - вернуть статус игры (обработано выше)
        # 2. Проверяем, есть ли другие ожидающие игроки (ПЕРЕД добавлением текущего)
        other_waiting = [uid for uid in game_main.waiting_players.keys() if uid != user_id]
        
        if other_waiting:
            # Найден соперник! Добавляем текущего игрока и создаем игру
            opponent_id = other_waiting[0]  # Берем первого доступного
            log_info(f"User {user_id} connecting to waiting player {opponent_id}")
            
            # Добавляем текущего игрока в очередь (если еще не там)
            if user_id not in game_main.waiting_players:
                game_main.waiting_players[user_id] = {
                    "paid": True,
                    "created_at": time.time()
                }
                
            # Оба игрока в очереди - создаем игру автоматически
            game_id = create_game_match(user_id, opponent_id)
            if game_id:
                log_info(f"Game {game_id} created: {user_id} vs {opponent_id}")
                return jsonify({
                    'status': 'ready_to_start',
                    'paid': True,
                    'game_starting': True,
                    'countdown': GAME_START_DELAY,
                    'message': 'Оба игрока готовы, игра скоро начнется'
                })
            else:
                # Игра не создана (возможно, уже создана - проверяем)
                if user_id in game_main.player_to_game:
                    game_id = game_main.player_to_game[user_id]
                    if game_id in game_main.active_games:
                        return jsonify({
                            'status': 'ready_to_start',
                            'paid': True,
                            'game_starting': True,
                            'countdown': GAME_START_DELAY,
                            'message': 'Оба игрока готовы, игра скоро начнется'
                        })
                # Игра не создана и не найдена - возвращаем ожидание
                return jsonify({
                    'status': 'waiting_opponent',
                    'paid': True,
                    'message': 'Ожидание второго игрока'
                })
        
        # Нет других ожидающих игроков - добавляем текущего в очередь
        # Проверяем, не находится ли игрок уже в очереди
        if user_id not in game_main.waiting_players:
            game_main.waiting_players[user_id] = {
                "paid": True,
                "created_at": time.time()
            }
            log_info(f"User {user_id} added to matchmaking queue (waiting for opponent)")
        else:
            log_info(f"User {user_id} already in matchmaking queue")
        
        return jsonify({
            'status': 'waiting_opponent',
            'paid': True,
            'message': 'Ожидание второго игрока'
        })
        
    except Exception as e:
        import traceback
        error_details = traceback.format_exc()
        log_error("api_start_game", e)
        log_info(f"Full traceback: {error_details}")
        return jsonify({
            'error': 'Internal server error',
            'details': str(e) if app.debug else None
        }), 500


@app.route('/api/game/check-payment', methods=['POST'])
def api_check_payment():
    """API для проверки оплаты"""
    try:
        data = request.json
        user_id = data.get('user_id')
        
        if not user_id:
            return jsonify({'error': 'User ID required'}), 400
        
        if user_id not in game_main.waiting_players:
            return jsonify({'paid': False, 'error': 'No payment found'}), 400
        
        invoice_id = game_main.waiting_players[user_id]["invoice_id"]
        invoice_data = crypto_pay.check_invoice(invoice_id)
        
        if not invoice_data:
            return jsonify({'paid': False}), 200
        
        status = invoice_data.get("status", "")
        status_lower = status.lower() if status else ""
        log_info(f"Checking payment status for user {user_id}, invoice {invoice_id}: {status} (raw data: {invoice_data})")
        
        # Проверяем статус оплаты (может быть "paid", "PAID", "active" и т.д.)
        if status_lower in ["paid", "active"]:
            # Помечаем как оплатившего
            game_main.waiting_players[user_id]["paid"] = True
            log_info(f"User {user_id} invoice {invoice_id} marked as paid")
            
            # Проверяем, есть ли второй игрок
            other_waiting = [uid for uid in game_main.waiting_players.keys() if uid != user_id]
            
            if other_waiting:
                opponent_id = other_waiting[0]
                opponent_data = game_main.waiting_players[opponent_id]
                
                # Проверяем оплату соперника
                if opponent_data.get("paid"):
                    # Оба игрока оплатили - создаем игру автоматически
                    game_id = create_game_match(user_id, opponent_id)
                    if game_id:
                        log_info(f"Game {game_id} created automatically in check-payment when both players paid")
                        return jsonify({
                            'paid': True,
                            'game_starting': True,
                            'countdown': GAME_START_DELAY
                        })
                    else:
                        # Игра не создана (возможно, уже создана) - проверяем статус
                        if user_id in game_main.player_to_game:
                            game_id = game_main.player_to_game[user_id]
                            if game_id in game_main.active_games:
                                return jsonify({
                                    'paid': True,
                                    'game_starting': True,
                                    'countdown': GAME_START_DELAY
                                })
                        return jsonify({
                            'paid': True,
                            'waiting': True,
                            'message': 'Ожидание создания игры...'
                        })
                else:
                    return jsonify({
                        'paid': True,
                        'waiting': True
                    })
            else:
                return jsonify({
                    'paid': True,
                    'waiting': True
                })
        else:
            log_info(f"User {user_id} invoice {invoice_id} status is {status}, not paid yet")
            return jsonify({'paid': False})
            
    except Exception as e:
        log_error("api_check_payment", e)
        return jsonify({'error': 'Internal server error'}), 500


@app.route('/api/game/start-play', methods=['POST'])
def api_start_play():
    """
    API для запуска игры после countdown
    Устанавливает game.is_running = True, чтобы тики начали работать
    """
    try:
        data = request.json
        user_id = data.get('user_id')
        
        if not user_id:
            return jsonify({'error': 'User ID required'}), 400
        
        if user_id not in game_main.player_to_game:
            return jsonify({'error': 'Not in game'}), 400
        
        game_id = game_main.player_to_game[user_id]
        if game_id not in game_main.active_games:
            return jsonify({'error': 'Game not found'}), 404
        
        game = game_main.active_games[game_id]
        
        # Запускаем игру (разрешаем тики)
        if not game.is_running and not game.is_finished:
            game.is_running = True
            game.game_start_timestamp = time.time()
            log_info(f"Game {game_id} started: is_running = True, tick_number = {game.tick_number}")
        
        return jsonify({
            'success': True,
            'game_running': game.is_running,
            'tick_number': game.tick_number,
            'message': 'Игра запущена'
        })
        
    except Exception as e:
        log_error("api_start_play", e)
        return jsonify({'error': 'Internal server error'}), 500


@app.route('/api/game/ready', methods=['POST'])
def api_game_ready():
    """API для сигнала готовности игрока (для синхронизации старта)"""
    try:
        data = request.json
        user_id = data.get('user_id')
        
        if not user_id:
            return jsonify({'error': 'User ID required'}), 400
        
        if user_id not in game_main.player_to_game:
            return jsonify({'error': 'Not in game'}), 400
        
        game_id = game_main.player_to_game[user_id]
        if game_id not in game_main.active_games:
            return jsonify({'error': 'Game not found'}), 404
        
        game = game_main.active_games[game_id]
        
        # Устанавливаем готовность игрока
        if user_id == game.player1_id:
            game.player1_ready = True
            log_info(f"Player 1 ({user_id}) is ready for game {game_id}")
        elif user_id == game.player2_id:
            game.player2_ready = True
            log_info(f"Player 2 ({user_id}) is ready for game {game_id}")
        else:
            return jsonify({'error': 'Invalid player'}), 400
        
        # Проверяем, готовы ли оба игрока
        both_ready = game.player1_ready and game.player2_ready
        
        # НЕ устанавливаем is_running здесь - это делается через /api/game/start-play после countdown
        # Система тиков работает только когда is_running = True
        if both_ready and not game.is_running:
            # Оба игрока готовы - устанавливаем timestamp для синхронизации countdown
            game.game_start_timestamp = time.time() + GAME_START_DELAY
            log_info(f"Both players ready! Game {game_id} will start after countdown at timestamp {game.game_start_timestamp}")
        
        return jsonify({
            'ready': True,
            'both_ready': both_ready,
            'game_start_timestamp': game.game_start_timestamp,
            'player1_ready': game.player1_ready,
            'player2_ready': game.player2_ready,
            'message': 'Готовность подтверждена' if not both_ready else 'Оба игрока готовы! Игра начинается...'
        })
        
    except Exception as e:
        log_error("api_game_ready", e)
        return jsonify({'error': 'Internal server error'}), 500


@app.route('/api/game/state', methods=['POST'])
def api_game_state():
    """API для получения текущего состояния игры (для синхронизации)"""
    try:
        data = request.json
        user_id = data.get('user_id')
        
        if not user_id:
            return jsonify({'error': 'User ID required'}), 400
        
        if user_id not in game_main.player_to_game:
            return jsonify({'error': 'Not in game'}), 400
        
        game_id = game_main.player_to_game[user_id]
        if game_id not in game_main.active_games:
            return jsonify({'error': 'Game not found'}), 404
        
        game = game_main.active_games[game_id]
        
        # СИСТЕМА ТИКОВ: НЕ обновляем игру здесь - это делает game_tick_loop
        # Просто возвращаем текущее состояние (обновленное последним тиком)
        
        # Определяем, какой игрок запрашивает состояние
        is_player1 = (user_id == game.player1_id)
        my_snake = game.snake1 if is_player1 else game.snake2
        opponent_snake = game.snake2 if is_player1 else game.snake1
        
        # Преобразуем тело змейки в список координат
        def snake_to_dict(snake):
            # Преобразуем направление в формат [dx, dy] для клиента
            if hasattr(snake.direction, 'value'):
                # Direction enum - получаем (dx, dy) tuple
                dir_value = snake.direction.value
                direction = [dir_value[0], dir_value[1]] if isinstance(dir_value, tuple) else dir_value
            elif isinstance(snake.direction, tuple):
                # Уже tuple (dx, dy)
                direction = [snake.direction[0], snake.direction[1]]
            else:
                direction = snake.direction
            
            return {
                'body': [(pos[0], pos[1]) for pos in snake.body],
                'alive': snake.alive,
                'direction': direction  # Формат [dx, dy] для клиента
            }
        
        # СИСТЕМА ТИКОВ: Возвращаем tick_number для синхронизации на клиенте
        # Клиент может игнорировать устаревшие обновления, сравнивая tick_number
        return jsonify({
            'tick_number': game.tick_number,  # Номер тика для синхронизации
            'last_tick_time': game.last_tick_time,  # Время последнего тика
            'game_running': game.is_running,
            'game_finished': game.is_finished,
            'game_start_timestamp': game.game_start_timestamp,
            'both_ready': game.player1_ready and game.player2_ready,
            'player1_ready': game.player1_ready,
            'player2_ready': game.player2_ready,
            'my_snake': snake_to_dict(my_snake),
            'opponent_snake': snake_to_dict(opponent_snake),
            'server_timestamp': time.time(),
            'winner_id': game.winner_id
        })
        
    except Exception as e:
        log_error("api_game_state", e)
        return jsonify({'error': 'Internal server error'}), 500


@app.route('/api/game/direction', methods=['POST'])
def api_game_direction():
    """API для отправки направления движения"""
    try:
        # Логируем полученный запрос для отладки
        log_info(f"Received /api/game/direction request. Content-Type: {request.content_type}")
        
        # Проверяем, что запрос содержит JSON
        if not request.is_json:
            log_error("api_game_direction", Exception(f"Request is not JSON. Content-Type: {request.content_type}, Data: {request.get_data(as_text=True)}"))
            return jsonify({'error': 'Content-Type must be application/json'}), 400
        
        data = request.json
        
        # Дополнительная проверка - если request.json вернул None
        if data is None:
            log_error("api_game_direction", Exception(f"request.json is None. Raw data: {request.get_data(as_text=True)}"))
            return jsonify({'error': 'Invalid JSON in request body'}), 400
        
        # Логируем полученные данные
        log_info(f"Received direction request data: {data}")
        
        user_id = data.get('user_id')
        direction_str = data.get('direction')
        
        # Детальная проверка каждого поля с логированием
        if not user_id:
            log_error("api_game_direction", Exception(f"user_id is missing or None. Received data: {data}"), user_id)
            return jsonify({
                'error': 'User ID required',
                'received_data': str(data),
                'missing_field': 'user_id'
            }), 400
        
        if not direction_str:
            log_error("api_game_direction", Exception(f"direction is missing or None. Received data: {data}"), user_id)
            return jsonify({
                'error': 'Direction required',
                'received_data': str(data),
                'missing_field': 'direction'
            }), 400
        
        # Проверяем тип direction_str (должен быть строка)
        if not isinstance(direction_str, str):
            log_error("api_game_direction", Exception(f"direction must be a string, got {type(direction_str)}: {direction_str}"), user_id)
            return jsonify({
                'error': f'Direction must be a string, got {type(direction_str).__name__}',
                'received_direction': str(direction_str),
                'direction_type': type(direction_str).__name__
            }), 400
        
        # Нормализуем direction_str (приводим к нижнему регистру)
        direction_str = direction_str.lower().strip()
        
        if user_id not in game_main.player_to_game:
            log_error("api_game_direction", Exception(f"User {user_id} not in player_to_game. Available players: {list(game_main.player_to_game.keys())}"), user_id)
            return jsonify({
                'error': 'Not in game',
                'user_id': user_id,
                'available_players': list(game_main.player_to_game.keys())
            }), 400
        
        game_id = game_main.player_to_game[user_id]
        if game_id not in game_main.active_games:
            log_error("api_game_direction", Exception(f"Game {game_id} not found in active_games. Available games: {list(game_main.active_games.keys())}"), user_id)
            return jsonify({
                'error': 'Game not found',
                'game_id': game_id,
                'available_games': list(game_main.active_games.keys())
            }), 404
        
        game = game_main.active_games[game_id]
        
        # СИСТЕМА ТИКОВ: Принимаем направления даже если игра еще не запущена (во время countdown)
        # Команды будут применены при первом тике после запуска игры
        if game.is_finished:
            log_error("api_game_direction", Exception(f"Game {game_id} is finished"), user_id)
            return jsonify({
                'error': 'Game finished',
                'is_finished': game.is_finished
            }), 400
        
        # Если игра еще не запущена, но создана - разрешаем сохранять направления
        # Они будут применены когда игра запустится (после countdown через /api/game/start-play)
        if not game.is_running:
            log_info(f"Game {game_id} not running yet (countdown?), but direction queued for future tick (is_running={game.is_running})")
        
        # Преобразуем строку в Direction (вне зависимости от is_running - команда сохраняется в очередь)
        direction_map = {
            "up": Direction.UP,
            "down": Direction.DOWN,
            "left": Direction.LEFT,
            "right": Direction.RIGHT
        }
        
        direction = direction_map.get(direction_str)
        if not direction:
            log_error("api_game_direction", Exception(f"Invalid direction string: '{direction_str}'. Valid values: {list(direction_map.keys())}"), user_id)
            return jsonify({
                'error': 'Invalid direction',
                'received_direction': direction_str,
                'valid_directions': list(direction_map.keys())
            }), 400
        
        # СИСТЕМА ТИКОВ: Сохраняем направление в очередь для следующего тика
        # НЕ обновляем игру сразу - это сделает game_tick_loop в следующем тике
        command_timestamp = time.time()
        game.queue_direction(user_id, direction, command_timestamp)
        
        # Определяем, какой игрок отправил направление
        is_player1 = (user_id == game.player1_id)
        opponent_snake = game.snake2 if is_player1 else game.snake1
        
        # SYNCHRONIZATION: Возвращаем позицию оппонента для синхронизации
        def snake_to_dict(snake):
            # Преобразуем направление в формат [dx, dy] для клиента
            if hasattr(snake.direction, 'value'):
                # Direction enum - получаем (dx, dy) tuple
                dir_value = snake.direction.value
                direction = [dir_value[0], dir_value[1]] if isinstance(dir_value, tuple) else dir_value
            elif isinstance(snake.direction, tuple):
                # Уже tuple (dx, dy)
                direction = [snake.direction[0], snake.direction[1]]
            else:
                direction = snake.direction
            
            return {
                'body': [(pos[0], pos[1]) for pos in snake.body],
                'alive': snake.alive,
                'direction': direction  # Формат [dx, dy] для клиента
            }
        
        log_info(f"Direction queued for user {user_id} in game {game_id}: {direction_str} (will apply in next tick)")
        
        # СИСТЕМА ТИКОВ: Возвращаем текущее состояние игры (последний тик) + подтверждение команды
        # Позиции змеек будут обновлены в следующем тике
        is_player1 = (user_id == game.player1_id)
        my_snake = game.snake1 if is_player1 else game.snake2
        
        def snake_to_dict_full(snake: 'Snake'):
            if hasattr(snake.direction, 'value'):
                dir_value = snake.direction.value
                direction = [dir_value[0], dir_value[1]] if isinstance(dir_value, tuple) else dir_value
            elif isinstance(snake.direction, tuple):
                direction = [snake.direction[0], snake.direction[1]]
            else:
                direction = snake.direction
            
            return {
                'body': [(pos[0], pos[1]) for pos in snake.body],
                'alive': snake.alive,
                'direction': direction
            }
        
        return jsonify({
            'success': True,
            'direction_queued': True,  # Подтверждение, что команда сохранена для следующего тика
            'tick_number': game.tick_number,  # Текущий номер тика
            'my_snake': snake_to_dict_full(my_snake),  # Текущая позиция моей змейки
            'opponent_snake': snake_to_dict_full(opponent_snake),  # Текущая позиция оппонента
            'game_finished': game.is_finished,
            'winner_id': game.winner_id
        })
        
    except Exception as e:
        import traceback
        error_details = traceback.format_exc()
        log_error("api_game_direction", e)
        log_info(f"Full traceback: {error_details}")
        log_info(f"Request data: {request.get_data(as_text=True)}")
        return jsonify({
            'error': 'Internal server error',
            'details': str(e) if app.debug else None
        }), 500


@app.route('/api/game/end', methods=['POST'])
def api_game_end():
    """API для окончания игры"""
    try:
        data = request.json
        user_id = data.get('user_id')
        winner = data.get('winner')
        head_to_head = data.get('headToHeadCollision', False)
        
        if not user_id:
            return jsonify({'error': 'User ID required'}), 400
        
        total_bank = GAME_PRICE_USD * 2
        prize_paid = False
        
        # Проверяем, находимся ли мы в активной игре
        if user_id not in game_main.player_to_game:
            return jsonify({
                'winner': False,
                'prize': 0,
                'message': 'Игра не найдена'
            }), 400
        
        game_id = game_main.player_to_game[user_id]
        if game_id not in game_main.active_games:
            return jsonify({
                'winner': False,
                'prize': 0,
                'message': 'Игра не найдена'
            }), 400
        
        game = game_main.active_games[game_id]
        
        # Проверяем, не была ли уже выплачена премия (защита от двойной выплаты)
        if hasattr(game, 'prize_paid') and game.prize_paid:
            log_info(f"Prize already paid for game {game_id}, skipping payout")
            prize_paid = True
        
        if head_to_head or winner == 'draw':
            # Столкновение "лоб в лоб" или ничья - вся сумма идет на комиссионный счет
            if OWNER_ID and not prize_paid:
                try:
                    success = crypto_pay.transfer(OWNER_ID, total_bank)
                    if success:
                        log_info(f"Head-to-head collision: transferred {total_bank} USDT to owner {OWNER_ID}")
                        prize_paid = True
                        if hasattr(game, 'prize_paid'):
                            game.prize_paid = True
                except Exception as e:
                    log_error("api_game_end", e, OWNER_ID)
            
            # Очищаем состояние игры
            _cleanup_game_state(game_id, game)
            
            return jsonify({
                'winner': False,
                'prize': 0,
                'draw': True,
                'message': 'Столкновение "лоб в лоб"! Вся сумма уходит на комиссионный счет.'
            })
        
        # Определяем победителя
        if game.winner_id:
            winner_id = game.winner_id
            is_winner = (winner_id == user_id)
            
            # Выплачиваем призы только один раз (первый запрос от любого игрока)
            if not prize_paid:
                winner_amount = total_bank * WINNER_PERCENTAGE  # 75% победителю
                owner_amount = total_bank * OWNER_PERCENTAGE    # 25% владельцу
                
                # Выплата победителю
                try:
                    winner_success = crypto_pay.transfer(winner_id, winner_amount)
                    if winner_success:
                        log_info(f"Prize {winner_amount} USDT transferred to winner {winner_id}")
                    else:
                        log_error("api_game_end", Exception("Failed to transfer prize to winner"), winner_id)
                except Exception as e:
                    log_error("api_game_end", e, winner_id)
                
                # Выплата владельцу (если указан)
                if OWNER_ID:
                    try:
                        owner_success = crypto_pay.transfer(OWNER_ID, owner_amount)
                        if owner_success:
                            log_info(f"Owner commission {owner_amount} USDT transferred to owner {OWNER_ID}")
                        else:
                            log_error("api_game_end", Exception("Failed to transfer owner commission"), OWNER_ID)
                    except Exception as e:
                        log_error("api_game_end", e, OWNER_ID)
                
                # Помечаем, что премия выплачена
                prize_paid = True
                if hasattr(game, 'prize_paid'):
                    game.prize_paid = True
            
            # Очищаем состояние игры
            _cleanup_game_state(game_id, game)
            
            return jsonify({
                'winner': is_winner,
                'prize': total_bank * WINNER_PERCENTAGE if is_winner else 0
            })
        
        # Если нет победителя, просто очищаем состояние
        _cleanup_game_state(game_id, game)
        
        return jsonify({
            'winner': False,
            'prize': 0
        })
        
    except Exception as e:
        log_error("api_game_end", e)
        return jsonify({'error': 'Internal server error'}), 500


def _cleanup_game_state(game_id: int, game: Game):
    """Очищает состояние игры после её завершения"""
    try:
        # Удаляем игроков из активных игр
        if game.player1_id in game_main.player_to_game:
            del game_main.player_to_game[game.player1_id]
        if game.player2_id in game_main.player_to_game:
            del game_main.player_to_game[game.player2_id]
        
        # USER ISOLATION: Удаляем из user_games для изоляции пользователей
        if game.player1_id in user_games:
            del user_games[game.player1_id]
            log_info(f"Removed player {game.player1_id} from user_games after game end")
        if game.player2_id in user_games:
            del user_games[game.player2_id]
            log_info(f"Removed player {game.player2_id} from user_games after game end")
        
        # Удаляем игроков из очереди ожидания (чтобы они должны были оплатить снова)
        if game.player1_id in game_main.waiting_players:
            del game_main.waiting_players[game.player1_id]
            log_info(f"Removed player {game.player1_id} from waiting_players after game end")
        if game.player2_id in game_main.waiting_players:
            del game_main.waiting_players[game.player2_id]
            log_info(f"Removed player {game.player2_id} from waiting_players after game end")
        
        # Удаляем саму игру
        if game_id in game_main.active_games:
            del game_main.active_games[game_id]
        
        log_info(f"Game {game_id} state cleaned up. Players {game.player1_id} and {game.player2_id} must pay again for next game.")
    except Exception as e:
        log_error("_cleanup_game_state", e)


if __name__ == '__main__':
    # WEBSOCKETS: Используем socketio.run() вместо app.run() для поддержки WebSockets
    socketio.run(app, host='0.0.0.0', port=5000, debug=True, allow_unsafe_werkzeug=True)

