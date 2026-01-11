"""
Точка входа для запуска бота и веб-приложения
"""

import os
import threading
import asyncio
from config import TELEGRAM_BOT_TOKEN
from logger import log_info

# Импортируем application после инициализации
def init_application():
    """Инициализирует приложение бота"""
    from main import start_command, button_handler
    from telegram.ext import Application, CommandHandler, CallbackQueryHandler
    
    token = os.getenv("TELEGRAM_BOT_TOKEN") or TELEGRAM_BOT_TOKEN
    if not token:
        return None
    
    app = Application.builder().token(token).build()
    app.add_handler(CommandHandler("start", start_command))
    app.add_handler(CallbackQueryHandler(button_handler))
    return app


def run_bot():
    """Запускает Telegram бота в отдельном потоке"""
    # Создаем новый event loop для этого потока
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    
    log_info("Bot thread starting...")
    
    # Инициализируем приложение в этом потоке
    application = init_application()
    if not application:
        log_info("Bot initialization failed: no token")
        loop.close()
        return
    
    try:
        # run_polling() использует установленный event loop
        application.run_polling(allowed_updates=None, stop_signals=None)
    except Exception as e:
        log_info(f"Bot thread error: {e}")
        import traceback
        traceback.print_exc()
    finally:
        loop.close()


def run_webapp():
    """Запускает Flask веб-приложение"""
    from webapp_api import app
    
    # Railway предоставляет PORT через переменную окружения
    port = int(os.getenv("PORT", "5000"))
    web_app_url = os.getenv("WEB_APP_URL", f"http://0.0.0.0:{port}")
    
    log_info(f"Web App API starting on 0.0.0.0:{port}")
    log_info(f"Web App URL: {web_app_url}")
    
    # Запускаем Flask на всех интерфейсах (0.0.0.0) и указанном порту
    app.run(host='0.0.0.0', port=port, debug=False, use_reloader=False)


if __name__ == "__main__":
    # Проверяем, есть ли токен
    token = os.getenv("TELEGRAM_BOT_TOKEN") or TELEGRAM_BOT_TOKEN
    
    if not token:
        print("Ошибка: не указан TELEGRAM_BOT_TOKEN!")
        print("Установите токен через переменную окружения")
        exit(1)
    
    # Запускаем бота в отдельном потоке
    bot_thread = threading.Thread(target=run_bot, daemon=True)
    bot_thread.start()
    
    # Даем боту время на инициализацию
    import time
    time.sleep(2)
    
    # Запускаем веб-приложение в основном потоке
    run_webapp()

