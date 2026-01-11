"""
Telegram бот - Игра Змейка
Многопользовательская игра 1 на 1 с платежной системой
"""

import asyncio
import os
from typing import Dict, Optional, Set
from datetime import datetime
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, Bot, WebAppInfo
from telegram.ext import Application, CommandHandler, CallbackQueryHandler, ContextTypes
from telegram.constants import ParseMode

from config import (
    TELEGRAM_BOT_TOKEN, GAME_START_DELAY, GAME_TICK_DELAY, GAME_PRICE_USD,
    WINNER_PERCENTAGE, OWNER_PERCENTAGE, SNAKE_COLOR_PLAYER1, SNAKE_COLOR_PLAYER2
)
from game import Game, Direction
from payment import crypto_pay
from logger import log_info, log_error, UserLogger


# Глобальные переменные для управления состоянием
waiting_players: Dict[int, Dict] = {}  # user_id -> {invoice_id, invoice_data, message_id}
active_games: Dict[int, Game] = {}  # game_id -> Game
player_to_game: Dict[int, int] = {}  # user_id -> game_id
game_messages: Dict[int, Dict[int, int]] = {}  # game_id -> {user_id: message_id}
game_tasks: Dict[int, asyncio.Task] = {}  # game_id -> Task
game_counter = 0


def get_game_id() -> int:
    """Генерирует уникальный ID игры"""
    global game_counter
    game_counter += 1
    return game_counter


async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Обработчик команды /start"""
    user_id = update.effective_user.id
    username = update.effective_user.username or f"User {user_id}"
    
    log_info(f"User {user_id} ({username}) started bot")
    
    # Проверяем, не находится ли игрок уже в игре
    if user_id in player_to_game:
        game_id = player_to_game[user_id]
        if game_id in active_games:
            await update.message.reply_text(
                UserLogger.warning_banner("Вы уже находитесь в игре!")
            )
            return
    
    # Проверяем, не ожидает ли игрок уже второго игрока
    if user_id in waiting_players:
        await update.message.reply_text(
            UserLogger.warning_banner("Вы уже ожидаете соперника. Пожалуйста, подтвердите оплату.")
        )
        return
    
    # Создаем кнопку для открытия Mini App
    web_app_url = os.getenv("WEB_APP_URL", "https://your-domain.com/webapp")
    keyboard = [
        [InlineKeyboardButton("🎮 Играть", web_app=WebAppInfo(url=web_app_url))]
    ]
    reply_markup = InlineKeyboardMarkup(keyboard)
    
    await update.message.reply_text(
        f"🐍 Добро пожаловать в игру Змейка!\n\n"
        f"💰 Стоимость участия: ${GAME_PRICE_USD}\n"
        f"🏆 Победитель получает 75% от банка\n\n"
        f"Нажмите кнопку ниже, чтобы открыть игру:",
        reply_markup=reply_markup
    )


async def button_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Обработчик нажатий на кнопки"""
    query = update.callback_query
    user_id = query.from_user.id
    data = query.data
    
    await query.answer()
    
    try:
        if data == "start_game":
            await handle_start_game(user_id, query, context)
        elif data == "pay_invoice":
            await handle_pay_invoice(user_id, query, context)
        elif data in ["up", "down", "left", "right"]:
            await handle_direction_change(user_id, data, query, context)
        elif data.endswith("_disabled"):
            # Игрок пытается управлять до оплаты
            await query.answer(UserLogger.warning_banner("Сначала необходимо оплатить участие в игре!"), show_alert=True)
        elif data == "check_payment":
            await handle_check_payment(user_id, query, context)
    except Exception as e:
        log_error("button_handler", e, user_id)
        await query.edit_message_text(UserLogger.error_banner("Произошла ошибка. Попробуйте еще раз."))


async def handle_start_game(user_id: int, query, context: ContextTypes.DEFAULT_TYPE):
    """Обработка начала игры - показывает интерфейс игры, затем требует оплату"""
    log_info(f"User {user_id} wants to start game")
    
    # Проверяем, не находится ли игрок уже в игре
    if user_id in player_to_game:
        game_id = player_to_game[user_id]
        if game_id in active_games:
            await query.edit_message_text(UserLogger.warning_banner("Вы уже находитесь в игре!"))
            return
    
    # Сначала показываем интерфейс игры (пустое поле)
    empty_field = render_empty_field()
    status_text = f"{UserLogger.info_banner('Ожидание игроков...')}\n\n"
    status_text += f"💰 Для присоединения к игре необходимо оплатить ${GAME_PRICE_USD}"
    
    # Проверяем, есть ли ожидающие игроки
    if waiting_players:
        # Есть ожидающий игрок - показываем его поле
        opponent_id = next(iter(waiting_players.keys()))
        opponent_data = waiting_players[opponent_id]
        
        # Если соперник уже оплатил, показываем его статус
        if opponent_data.get("paid"):
            status_text = f"{UserLogger.success_banner('Игрок ожидает соперника!')}\n\n"
            status_text += f"💰 Для присоединения к игре необходимо оплатить ${GAME_PRICE_USD}"
        else:
            status_text = f"{UserLogger.info_banner('Игрок ожидает оплаты...')}\n\n"
            status_text += f"💰 Для присоединения к игре необходимо оплатить ${GAME_PRICE_USD}"
    
    # Создаем счет для текущего игрока
    invoice = await crypto_pay.create_invoice(user_id)
    if not invoice:
        await query.edit_message_text(
            UserLogger.error_banner("Не удалось создать счет на оплату. Попробуйте позже.")
        )
        return
    
    # Сохраняем информацию об ожидающем игроке
    waiting_players[user_id] = {
        "invoice_id": invoice.get("invoice_id"),
        "invoice_data": invoice,
        "message_id": query.message.message_id,
        "paid": False
    }
    
    # Создаем кнопки: управление (пока неактивные) и оплата
    keyboard = [
        [
            InlineKeyboardButton("⬆️", callback_data="up_disabled"),
            InlineKeyboardButton("⬇️", callback_data="down_disabled")
        ],
        [
            InlineKeyboardButton("⬅️", callback_data="left_disabled"),
            InlineKeyboardButton("➡️", callback_data="right_disabled")
        ],
        [InlineKeyboardButton("💳 Оплатить $1 для присоединения", url=invoice.get("pay_url", "#"))],
        [InlineKeyboardButton("✅ Проверить оплату", callback_data="check_payment")]
    ]
    reply_markup = InlineKeyboardMarkup(keyboard)
    
    full_text = f"{empty_field}\n\n{status_text}"
    
    await query.edit_message_text(
        full_text,
        reply_markup=reply_markup
    )


async def handle_check_payment(user_id: int, query, context: ContextTypes.DEFAULT_TYPE):
    """Обработка проверки оплаты"""
    if user_id not in waiting_players:
        await query.answer(UserLogger.error_banner("Ошибка: не найдена информация об оплате."), show_alert=True)
        return
    
    invoice_id = waiting_players[user_id]["invoice_id"]
    invoice_data = await crypto_pay.check_invoice(invoice_id)
    
    if not invoice_data:
        await query.answer(UserLogger.error_banner("Не удалось проверить статус оплаты. Попробуйте позже."), show_alert=True)
        return
    
    status = invoice_data.get("status", "").lower()
    
    if status == "paid":
        # Помечаем как оплатившего
        waiting_players[user_id]["paid"] = True
        
        # Проверяем, есть ли второй игрок
        other_waiting = [uid for uid in waiting_players.keys() if uid != user_id]
        
        if other_waiting:
            opponent_id = other_waiting[0]
            opponent_data = waiting_players[opponent_id]
            
            # Проверяем оплату соперника
            if opponent_data.get("paid"):
                # Оба игрока оплатили - создаем игру
                await query.answer(UserLogger.success_banner("Оплата подтверждена! Начинаем игру..."), show_alert=True)
                # Создаем игру
                await create_match_with_query(user_id, opponent_id, query, context)
            else:
                # Ждем оплаты соперника - обновляем интерфейс
                empty_field = render_empty_field()
                status_text = f"{UserLogger.success_banner('Оплата подтверждена!')}\n\n"
                status_text += f"{UserLogger.info_banner('Ожидание оплаты соперника...')}\n"
                status_text += f"💰 Соперник должен оплатить ${GAME_PRICE_USD}"
                
                # Кнопки управления пока неактивны
                keyboard = [
                    [
                        InlineKeyboardButton("⬆️", callback_data="up_disabled"),
                        InlineKeyboardButton("⬇️", callback_data="down_disabled")
                    ],
                    [
                        InlineKeyboardButton("⬅️", callback_data="left_disabled"),
                        InlineKeyboardButton("➡️", callback_data="right_disabled")
                    ],
                    [InlineKeyboardButton("✅ Проверить оплату", callback_data="check_payment")]
                ]
                reply_markup = InlineKeyboardMarkup(keyboard)
                
                await query.answer(UserLogger.success_banner("Оплата подтверждена! Ожидаем оплату соперника..."), show_alert=True)
                try:
                    await query.edit_message_text(
                        f"{empty_field}\n\n{status_text}",
                        reply_markup=reply_markup
                    )
                except:
                    pass
        else:
            # Ждем второго игрока - обновляем интерфейс
            empty_field = render_empty_field()
            status_text = f"{UserLogger.success_banner('Оплата подтверждена!')}\n\n"
            status_text += f"{UserLogger.info_banner('Ожидание второго игрока...')}\n"
            status_text += f"💰 Второй игрок должен оплатить ${GAME_PRICE_USD}"
            
            # Кнопки управления пока неактивны
            keyboard = [
                [
                    InlineKeyboardButton("⬆️", callback_data="up_disabled"),
                    InlineKeyboardButton("⬇️", callback_data="down_disabled")
                ],
                [
                    InlineKeyboardButton("⬅️", callback_data="left_disabled"),
                    InlineKeyboardButton("➡️", callback_data="right_disabled")
                ],
                [InlineKeyboardButton("✅ Проверить оплату", callback_data="check_payment")]
            ]
            reply_markup = InlineKeyboardMarkup(keyboard)
            
            await query.answer(UserLogger.success_banner("Оплата подтверждена! Ожидаем второго игрока..."), show_alert=True)
            try:
                await query.edit_message_text(
                    f"{empty_field}\n\n{status_text}",
                    reply_markup=reply_markup
                )
            except:
                pass
    else:
        await query.answer(UserLogger.warning_banner("Оплата еще не подтверждена. Пожалуйста, оплатите счет."), show_alert=True)


async def create_match_with_query(player1_id: int, player2_id: int, query, context: ContextTypes.DEFAULT_TYPE):
    """Создает матч между двумя игроками с использованием query для первого игрока"""
    log_info(f"Creating match: Player1 {player1_id} vs Player2 {player2_id}")
    
    # Создаем игру
    game = Game(player1_id, player2_id)
    game_id = get_game_id()
    active_games[game_id] = game
    player_to_game[player1_id] = game_id
    player_to_game[player2_id] = game_id
    
    # Удаляем из ожидающих
    if player1_id in waiting_players:
        del waiting_players[player1_id]
    if player2_id in waiting_players:
        del waiting_players[player2_id]
    
    # Отправляем сообщение о начале игры
    countdown_text = f"🎮 Игра начинается через {GAME_START_DELAY} секунд!\n\n"
    countdown_text += "Подготовьтесь к игре..."
    
    bot = context.bot
    
    # Для первого игрока обновляем текущее сообщение
    try:
        await query.edit_message_text(countdown_text)
        message1_id = query.message.message_id
    except:
        message1 = await bot.send_message(player1_id, countdown_text)
        message1_id = message1.message_id
    
    # Для второго игрока отправляем новое сообщение
    message2 = await bot.send_message(player2_id, countdown_text)
    message2_id = message2.message_id
    
    game_messages[game_id] = {
        player1_id: message1_id,
        player2_id: message2_id
    }
    
    # Запускаем обратный отсчет
    for i in range(GAME_START_DELAY, 0, -1):
        countdown_text = f"🎮 Игра начинается через {i} секунд!\n\n"
        countdown_text += "Подготовьтесь к игре..."
        
        try:
            await bot.edit_message_text(
                chat_id=player1_id,
                message_id=message1_id,
                text=countdown_text
            )
            await bot.edit_message_text(
                chat_id=player2_id,
                message_id=message2_id,
                text=countdown_text
            )
        except:
            pass
        
        await asyncio.sleep(1)
    
    # Начинаем игру
    game.is_running = True
    game_task = asyncio.create_task(run_game(game_id, context))
    game_tasks[game_id] = game_task


async def create_match(player1_id: int, player2_id: int, query, context: ContextTypes.DEFAULT_TYPE):
    """Создает матч (устаревший метод, используем create_match_with_query)"""
    await create_match_with_query(player1_id, player2_id, query, context)


def render_empty_field() -> str:
    """Отрисовывает пустое игровое поле"""
    from config import GAME_FIELD_WIDTH, GAME_FIELD_HEIGHT
    
    # Создаем пустое поле
    field = [['⬜' for _ in range(GAME_FIELD_WIDTH)] for _ in range(GAME_FIELD_HEIGHT)]
    
    # Добавляем границы
    for i in range(GAME_FIELD_HEIGHT):
        field[i][0] = '🟦'  # Левая граница
        field[i][GAME_FIELD_WIDTH - 1] = '🟦'  # Правая граница
    for j in range(GAME_FIELD_WIDTH):
        field[0][j] = '🟦'  # Верхняя граница
        field[GAME_FIELD_HEIGHT - 1][j] = '🟦'  # Нижняя граница
    
    # Преобразуем в строку
    lines = [''.join(row) for row in field]
    return '\n'.join(lines)


async def handle_direction_change(user_id: int, direction_str: str, query, context: ContextTypes.DEFAULT_TYPE):
    """Обработка изменения направления"""
    if user_id not in player_to_game:
        await query.answer(UserLogger.error_banner("Вы не в игре!"), show_alert=True)
        return
    
    game_id = player_to_game[user_id]
    if game_id not in active_games:
        await query.answer(UserLogger.error_banner("Игра не найдена!"), show_alert=True)
        return
    
    game = active_games[game_id]
    if not game.is_running or game.is_finished:
        await query.answer(UserLogger.warning_banner("Игра не запущена или уже завершена!"), show_alert=True)
        return
    
    # Преобразуем строку в Direction
    direction_map = {
        "up": Direction.UP,
        "down": Direction.DOWN,
        "left": Direction.LEFT,
        "right": Direction.RIGHT
    }
    
    direction = direction_map.get(direction_str)
    if direction:
        game.set_direction(user_id, direction)
        await query.answer("✅")


async def run_game(game_id: int, context: ContextTypes.DEFAULT_TYPE):
    """Запускает игровой цикл"""
    if game_id not in active_games:
        return
    
    game = active_games[game_id]
    bot = context.bot
    
    try:
        while game.is_running and not game.is_finished:
            # Обновляем состояние игры
            game.update()
            
            # Отрисовываем поле
            field_text = game.render_field()
            status_text = game.get_game_status_text()
            
            full_text = f"{field_text}\n\n{status_text}"
            
            # Добавляем кнопки управления
            keyboard = [
                [
                    InlineKeyboardButton("⬆️", callback_data="up"),
                    InlineKeyboardButton("⬇️", callback_data="down")
                ],
                [
                    InlineKeyboardButton("⬅️", callback_data="left"),
                    InlineKeyboardButton("➡️", callback_data="right")
                ]
            ]
            reply_markup = InlineKeyboardMarkup(keyboard)
            
            # Обновляем сообщения для обоих игроков
            for user_id, message_id in game_messages.get(game_id, {}).items():
                try:
                    await bot.edit_message_text(
                        chat_id=user_id,
                        message_id=message_id,
                        text=full_text,
                        reply_markup=reply_markup
                    )
                except Exception as e:
                    log_error("run_game_edit_message", e, user_id)
            
            if game.is_finished:
                break
            
            await asyncio.sleep(GAME_TICK_DELAY)
        
        # Игра завершена - обрабатываем результаты
        await handle_game_end(game_id, context)
        
    except Exception as e:
        log_error("run_game", e)
        await handle_game_end(game_id, context)


async def handle_game_end(game_id: int, context: ContextTypes.DEFAULT_TYPE):
    """Обрабатывает окончание игры"""
    if game_id not in active_games:
        return
    
    game = active_games[game_id]
    bot = context.bot
    
    # Отправляем финальное сообщение
    field_text = game.render_field()
    status_text = game.get_game_status_text()
    
    result_text = ""
    if game.winner_id:
        winner_player_num = 1 if game.winner_id == game.player1_id else 2
        result_text = f"\n\n🏆 Победитель: Игрок {winner_player_num} ({game.winner_id})"
        
        # Выплачиваем выигрыш
        total_bank = GAME_PRICE_USD * 2
        winner_amount = total_bank * WINNER_PERCENTAGE
        owner_amount = total_bank * OWNER_PERCENTAGE
        
        # Переводим выигрыш победителю
        success = await crypto_pay.transfer(game.winner_id, winner_amount)
        if success:
            result_text += f"\n💰 Выигрыш: ${winner_amount:.2f}"
        else:
            result_text += f"\n⚠️ Ошибка при переводе выигрыша"
        
        # Переводим комиссию владельцу (если указан)
        from config import OWNER_ID
        if OWNER_ID:
            owner_success = await crypto_pay.transfer(OWNER_ID, owner_amount)
            if not owner_success:
                log_error("handle_game_end", Exception("Failed to transfer owner fee"), OWNER_ID)
    else:
        result_text = "\n\n🤝 Ничья!"
        # Возвращаем деньги обоим игрокам
        for player_id in [game.player1_id, game.player2_id]:
            await crypto_pay.transfer(player_id, GAME_PRICE_USD)
    
    full_text = f"{field_text}\n\n{status_text}{result_text}"
    
    # Отправляем финальное сообщение обоим игрокам
    for user_id, message_id in game_messages.get(game_id, {}).items():
        try:
            await bot.edit_message_text(
                chat_id=user_id,
                message_id=message_id,
                text=full_text
            )
        except Exception as e:
            log_error("handle_game_end_edit", e, user_id)
    
    # Очищаем данные игры
    if game_id in game_tasks:
        task = game_tasks[game_id]
        if not task.done():
            task.cancel()
        del game_tasks[game_id]
    
    # Удаляем игроков из игры
    if game.player1_id in player_to_game:
        del player_to_game[game.player1_id]
    if game.player2_id in player_to_game:
        del player_to_game[game.player2_id]
    
    del active_games[game_id]
    if game_id in game_messages:
        del game_messages[game_id]
    
    log_info(f"Game {game_id} ended. Winner: {game.winner_id}")


# Глобальное приложение бота (создается при импорте)
token = os.getenv("TELEGRAM_BOT_TOKEN") or TELEGRAM_BOT_TOKEN
application = None

if token:
    application = Application.builder().token(token).build()
    # Регистрируем обработчики
    application.add_handler(CommandHandler("start", start_command))
    application.add_handler(CallbackQueryHandler(button_handler))


def main():
    """Главная функция запуска бота"""
    global application
    
    if not token:
        print("Ошибка: не указан TELEGRAM_BOT_TOKEN!")
        print("Установите токен через переменную окружения или в config.py")
        return
    
    if not application:
        application = Application.builder().token(token).build()
        application.add_handler(CommandHandler("start", start_command))
        application.add_handler(CallbackQueryHandler(button_handler))
    
    # Запускаем бота
    log_info("Bot starting...")
    application.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()

