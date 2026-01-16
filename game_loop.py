"""
Система игровых тиков для синхронизации мультиплеерных игр

Архитектура:
- Все активные игры обновляются строго по фиксированным тикам (каждые TICK_INTERVAL мс)
- Каждый тик применяет последние направления из pending_directions каждой игры
- После тика состояние игры рассылается всем клиентам через polling response
- Это гарантирует идеальную синхронизацию: оба игрока видят одно и то же состояние
"""

import asyncio
import time
from typing import Dict
from logger import log_info, log_error

# Интервал между тиками в секундах (500ms)
TICK_INTERVAL = 0.5

# Глобальный флаг для остановки игрового цикла
_game_loop_running = False
_game_loop_task: asyncio.Task = None


async def game_tick_loop(active_games: Dict[int, 'Game'], broadcast_callback=None):
    """
    Основной цикл игровых тиков
    
    Этот цикл запускается как asyncio задача и выполняет тики для всех активных игр
    строго по расписанию (каждые TICK_INTERVAL секунд).
    
    Args:
        active_games: Словарь всех активных игр {game_id: Game}
        broadcast_callback: Опциональная функция callback(game_id) для broadcast после тика
    
    Логика:
    1. Спим TICK_INTERVAL секунд
    2. Для каждой активной игры вызываем game.tick()
    3. После тика вызываем broadcast_callback(game_id) если она предоставлена
    4. Если игра завершена, она будет удалена из active_games позже
    5. Повторяем
    """
    global _game_loop_running
    
    log_info("Game tick loop started")
    _game_loop_running = True
    
    try:
        while _game_loop_running:
            # Спим до следующего тика
            await asyncio.sleep(TICK_INTERVAL)
            
            # Получаем текущее время для всех тиков в этом цикле
            current_time = time.time()
            
            # Создаем копию списка game_id для безопасной итерации
            # (активные игры могут удаляться во время итерации)
            game_ids = list(active_games.keys())
            
            if not game_ids:
                # Нет активных игр, продолжаем цикл
                continue
            
            # Выполняем тик для каждой активной игры
            for game_id in game_ids:
                if game_id not in active_games:
                    # Игра была удалена во время итерации
                    continue
                
                game = active_games[game_id]
                
                try:
                    # Выполняем тик игры
                    game_continues = game.tick(current_time)
                    
                    # WEBSOCKETS: Отправляем обновление состояния игры через WebSocket
                    # только если игра запущена (is_running=True)
                    if game.is_running and broadcast_callback:
                        try:
                            broadcast_callback(game_id)
                        except Exception as e:
                            log_error(f"broadcast_callback_game_{game_id}", e)
                    
                    if not game_continues:
                        # Игра завершена, логируем и отправляем финальное состояние
                        log_info(f"Game {game_id} finished during tick {game.tick_number}")
                        if broadcast_callback:
                            try:
                                broadcast_callback(game_id)
                            except Exception as e:
                                log_error(f"broadcast_callback_game_{game_id}_final", e)
                    
                except Exception as e:
                    log_error(f"game_tick_loop_game_{game_id}", e)
                    # Продолжаем обработку других игр даже если одна упала
            
            # Логируем статистику (раз в 10 секунд, чтобы не спамить)
            if int(current_time) % 10 == 0:
                running_games = sum(1 for g in active_games.values() if g.is_running and not g.is_finished)
                log_info(f"Game tick loop: {len(active_games)} total games, {running_games} running")
    
    except asyncio.CancelledError:
        log_info("Game tick loop cancelled")
    except Exception as e:
        log_error("game_tick_loop", e)
    finally:
        _game_loop_running = False
        log_info("Game tick loop stopped")


def start_game_tick_loop(active_games: Dict[int, 'Game']) -> asyncio.Task:
    """
    Запускает игровой цикл тиков в отдельной asyncio задаче
    
    Args:
        active_games: Словарь всех активных игр (должен быть общим для всех модулей)
    
    Returns:
        asyncio.Task для контроля жизненного цикла задачи
    
    Важно: Этот цикл должен быть запущен один раз при старте приложения
    """
    global _game_loop_task, _game_loop_running
    
    if _game_loop_running:
        log_info("Game tick loop is already running")
        return _game_loop_task
    
    if _game_loop_task is not None and not _game_loop_task.done():
        log_info("Game tick loop task already exists, reusing")
        return _game_loop_task
    
    # Создаем новую задачу
    _game_loop_task = asyncio.create_task(game_tick_loop(active_games))
    log_info(f"Game tick loop task created: {_game_loop_task}")
    
    return _game_loop_task


def stop_game_tick_loop():
    """
    Останавливает игровой цикл тиков
    
    Вызывается при остановке приложения (graceful shutdown)
    """
    global _game_loop_running, _game_loop_task
    
    _game_loop_running = False
    
    if _game_loop_task and not _game_loop_task.done():
        _game_loop_task.cancel()
        log_info("Game tick loop stop requested")


def is_game_loop_running() -> bool:
    """Проверяет, запущен ли игровой цикл тиков"""
    return _game_loop_running


