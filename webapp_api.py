"""
API эндпоинты для веб-приложения Telegram Mini App
"""

from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
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
import threading
import time

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
        
        # Проверяем, что оба игрока оплатили
        player1_data = game_main.waiting_players[player1_id]
        player2_data = game_main.waiting_players[player2_id]
        
        if not player1_data.get("paid") or not player2_data.get("paid"):
            log_info(f"Cannot create match: one or both players not paid. Player1: {player1_data.get('paid')}, Player2: {player2_data.get('paid')}")
            return None
        
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
        
        log_info(f"Game {game_id} created: Player1 {player1_id} vs Player2 {player2_id}")
        return game_id

app = Flask(__name__, static_folder='webapp')
CORS(app)

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
        if user_id in game_main.player_to_game:
            game_id = game_main.player_to_game[user_id]
            if game_id in game_main.active_games:
                game = game_main.active_games[game_id]
                return jsonify({
                    'in_game': True,
                    'game_running': game.is_running,
                    'game_finished': game.is_finished,
                    'status': 'playing' if game.is_running and not game.is_finished else 'finished'
                })
        
        # Проверяем, есть ли ожидающий игрок (включая текущего)
        if user_id in game_main.waiting_players:
            player_data = game_main.waiting_players[user_id]
            invoice_id = player_data.get("invoice_id")
            invoice_data = player_data.get("invoice_data", {})
            
            # Если статус оплаты не установлен, проверяем инвойс
            if not player_data.get("paid") and invoice_id:
                invoice_status = crypto_pay.check_invoice(invoice_id)
                if invoice_status:
                    invoice_status_str = invoice_status.get("status", "")
                    invoice_status_lower = invoice_status_str.lower() if invoice_status_str else ""
                    log_info(f"Checking invoice {invoice_id} status for user {user_id}: {invoice_status_str} (full data: {invoice_status})")
                    # Проверяем статус оплаты (может быть "paid", "PAID", "active" и т.д.)
                    if invoice_status_lower in ["paid", "active"]:
                        # Инвойс оплачен, обновляем статус
                        game_main.waiting_players[user_id]["paid"] = True
                        player_data["paid"] = True
                        log_info(f"User {user_id} invoice {invoice_id} is paid, status updated")
                    else:
                        log_info(f"User {user_id} invoice {invoice_id} status is {invoice_status_str}, not paid yet")
            
            # Проверяем статус оплаты
            if player_data.get("paid"):
                # Игрок оплатил - проверяем, есть ли второй игрок
                other_waiting = [uid for uid in game_main.waiting_players.keys() if uid != user_id]
                if other_waiting:
                    opponent_id = other_waiting[0]
                    opponent_data = game_main.waiting_players[opponent_id]
                    if opponent_data.get("paid"):
                        # Оба игрока оплатили - создаем игру автоматически
                        game_id = create_game_match(user_id, opponent_id)
                        if game_id:
                            log_info(f"Game {game_id} created automatically when both players paid")
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
                            'status': 'waiting_opponent_payment',
                            'paid': True,
                            'message': 'Ожидание оплаты соперника'
                        })
                else:
                    return jsonify({
                        'status': 'waiting_opponent',
                        'paid': True,
                        'message': 'Ожидание второго игрока'
                    })
            else:
                # Игрок не оплатил - возвращаем информацию об инвойсе
                invoice_url = invoice_data.get("pay_url") or invoice_data.get("url") or invoice_data.get("payUrl")
                return jsonify({
                    'status': 'payment_required',
                    'paid': False,
                    'invoice_url': invoice_url,
                    'invoice_id': invoice_id,
                    'message': 'Требуется оплата'
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
        if user_id in game_main.player_to_game:
            game_id = game_main.player_to_game[user_id]
            if game_id in game_main.active_games:
                game = game_main.active_games[game_id]
                if game.is_running and not game.is_finished:
                    return jsonify({
                        'in_game': True,
                        'game_running': True
                    })
        
        # Проверяем, есть ли уже ожидающий игрок с этим user_id
        if user_id in game_main.waiting_players:
            player_data = game_main.waiting_players[user_id]
            invoice_data = player_data.get("invoice_data", {})
            invoice_url = invoice_data.get("pay_url") or invoice_data.get("url") or invoice_data.get("payUrl")
            
            if player_data.get("paid"):
                # Игрок уже оплатил - проверяем статус
                other_waiting = [uid for uid in game_main.waiting_players.keys() if uid != user_id]
                if other_waiting:
                    opponent_id = other_waiting[0]
                    opponent_data = game_main.waiting_players[opponent_id]
                    if opponent_data.get("paid"):
                        # Оба игрока оплатили - начинаем игру
                        return jsonify({
                            'game_starting': True,
                            'countdown': GAME_START_DELAY
                        })
                    else:
                        return jsonify({
                            'waiting': True,
                            'paid': True,
                            'message': 'Ожидание оплаты соперника'
                        })
                else:
                    return jsonify({
                        'waiting': True,
                        'paid': True,
                        'message': 'Ожидание второго игрока'
                    })
            else:
                # Игрок не оплатил - возвращаем существующий инвойс
                log_info(f"User {user_id} already has invoice, returning existing invoice")
                if invoice_url:
                    return jsonify({
                        'requires_payment': True,
                        'invoice_url': invoice_url,
                        'invoice_id': player_data.get("invoice_id"),
                        'existing': True
                    })
                else:
                    # URL не найден, создаем новый
                    log_info(f"Invoice URL not found, creating new invoice")
        
        # Проверяем, есть ли ожидающие игроки (другие, не текущий)
        other_waiting = [uid for uid in game_main.waiting_players.keys() if uid != user_id]
        if other_waiting:
            # Случайно выбираем одного из ожидающих игроков для подключения
            opponent_id = random.choice(other_waiting)
            opponent_data = game_main.waiting_players[opponent_id]
            log_info(f"User {user_id} connecting to existing waiting player {opponent_id}")
            
            # Если соперник уже оплатил, создаем инвойс для текущего игрока
            if opponent_data.get("paid"):
                # Создаем счет для текущего игрока
                try:
                    invoice = crypto_pay.create_invoice(user_id)
                    if not invoice:
                        log_error("api_start_game", Exception("Invoice creation returned None for second player (opponent paid)"), user_id)
                        return jsonify({'error': 'Failed to create invoice. Please try again later.'}), 500
                except Exception as e:
                    log_error("api_start_game", e, user_id)
                    return jsonify({'error': f'Failed to create invoice: {str(e)}'}), 500
                
                invoice_url = invoice.get("pay_url") or invoice.get("url") or invoice.get("payUrl") or invoice.get("invoice_url")
                
                if not invoice_url or invoice_url == "#":
                    log_error("api_start_game", Exception(f"No payment URL in invoice: {invoice}"), user_id)
                    return jsonify({'error': 'Failed to get payment URL from invoice'}), 500
                
                # Сохраняем информацию об ожидающем игроке
                game_main.waiting_players[user_id] = {
                    "invoice_id": invoice.get("invoice_id"),
                    "invoice_data": invoice,
                    "paid": False
                }
                
                return jsonify({
                    'requires_payment': True,
                    'invoice_url': invoice_url
                })
            else:
                # Соперник еще не оплатил - создаем инвойс для текущего игрока
                try:
                    invoice = crypto_pay.create_invoice(user_id)
                    if not invoice:
                        log_error("api_start_game", Exception("Invoice creation returned None for waiting player (opponent not paid)"), user_id)
                        return jsonify({'error': 'Failed to create invoice. Please try again later.'}), 500
                except Exception as e:
                    log_error("api_start_game", e, user_id)
                    return jsonify({'error': f'Failed to create invoice: {str(e)}'}), 500
                
                invoice_url = invoice.get("pay_url") or invoice.get("url") or invoice.get("payUrl") or invoice.get("invoice_url")
                
                if not invoice_url or invoice_url == "#":
                    log_error("api_start_game", Exception(f"No payment URL in invoice: {invoice}"), user_id)
                    return jsonify({'error': 'Failed to get payment URL from invoice'}), 500
                
                # Сохраняем информацию об ожидающем игроке
                game_main.waiting_players[user_id] = {
                    "invoice_id": invoice.get("invoice_id"),
                    "invoice_data": invoice,
                    "paid": False
                }
                
                return jsonify({
                    'requires_payment': True,
                    'invoice_url': invoice_url
                })
        
        # Создаем счет для текущего игрока (первый игрок)
        try:
            invoice = crypto_pay.create_invoice(user_id)
            if not invoice:
                log_error("api_start_game", Exception("Invoice creation returned None for first player"), user_id)
                return jsonify({'error': 'Failed to create invoice. Please try again later.'}), 500
        except Exception as e:
            log_error("api_start_game", e, user_id)
            return jsonify({'error': f'Failed to create invoice: {str(e)}'}), 500
        
        # Получаем URL для оплаты из инвойса (пробуем разные варианты)
        invoice_url = invoice.get("pay_url") or invoice.get("url") or invoice.get("payUrl") or invoice.get("invoice_url")
        
        log_info(f"Invoice created for user {user_id}: invoice={invoice}, url={invoice_url}")
        
        if not invoice_url or invoice_url == "#":
            log_error("api_start_game", Exception(f"No payment URL in invoice: {invoice}"), user_id)
            return jsonify({'error': 'Failed to get payment URL from invoice'}), 500
        
        # Сохраняем информацию об ожидающем игроке
        game_main.waiting_players[user_id] = {
            "invoice_id": invoice.get("invoice_id"),
            "invoice_data": invoice,
            "paid": False
        }
        
        return jsonify({
            'requires_payment': True,
            'invoice_url': invoice_url,
            'invoice_id': invoice.get("invoice_id")
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
        
        if both_ready and not game.is_running:
            # Оба игрока готовы - устанавливаем timestamp для синхронизации
            game.game_start_timestamp = time.time() + GAME_START_DELAY
            game.is_running = True
            log_info(f"Both players ready! Game {game_id} starting at timestamp {game.game_start_timestamp}")
        
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
        
        # Определяем, какой игрок запрашивает состояние
        is_player1 = (user_id == game.player1_id)
        my_snake = game.snake1 if is_player1 else game.snake2
        opponent_snake = game.snake2 if is_player1 else game.snake1
        
        # Преобразуем тело змейки в список координат
        def snake_to_dict(snake):
            return {
                'body': [(pos[0], pos[1]) for pos in snake.body],
                'alive': snake.alive,
                'direction': snake.direction.value if hasattr(snake.direction, 'value') else (snake.direction[0], snake.direction[1]) if isinstance(snake.direction, tuple) else snake.direction
            }
        
        return jsonify({
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
        
        if not game.is_running or game.is_finished:
            log_error("api_game_direction", Exception(f"Game {game_id} is not running. is_running={game.is_running}, is_finished={game.is_finished}"), user_id)
            return jsonify({
                'error': 'Game not running',
                'is_running': game.is_running,
                'is_finished': game.is_finished
            }), 400
        
        # Преобразуем строку в Direction
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
        
        # Устанавливаем направление
        game.set_direction(user_id, direction)
        log_info(f"Direction updated for user {user_id} in game {game_id}: {direction_str}")
        return jsonify({'success': True})
        
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
    app.run(host='0.0.0.0', port=5000, debug=True)

