"""
Точка входа для запуска бота и веб-приложения
"""

import os
import sys
import threading
import asyncio
import signal
import time
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
    
    # Небольшая задержка перед запуском бота для стабилизации
    time.sleep(2)
    
    # Инициализируем приложение в этом потоке
    application = init_application()
    if not application:
        log_info("Bot initialization failed: no token")
        loop.close()
        return
    
    try:
        # run_polling() использует установленный event loop
        application.run_polling(allowed_updates=None, stop_signals=None)
    except KeyboardInterrupt:
        log_info("Bot polling interrupted by user")
    except Exception as e:
        log_info(f"Bot thread error: {e}")
        import traceback
        traceback.print_exc()
    finally:
        try:
            # Корректно останавливаем бота перед закрытием для освобождения соединения с Telegram
            if application:
                log_info("Stopping bot polling...")
                try:
                    # Останавливаем polling
                    loop.run_until_complete(application.stop())
                    # Завершаем работу приложения
                    loop.run_until_complete(application.shutdown())
                    log_info("Bot stopped successfully")
                except AttributeError as e:
                    # Если методы недоступны
                    log_info(f"Application stop methods not available: {e}")
                except Exception as e:
                    log_info(f"Error stopping bot: {e}")
        except Exception as e:
            log_info(f"Error in bot cleanup: {e}")
        finally:
            try:
                # Отменяем все оставшиеся задачи перед закрытием loop
                pending = asyncio.all_tasks(loop)
                if pending:
                    log_info(f"Cancelling {len(pending)} pending tasks...")
                    for task in pending:
                        task.cancel()
                    # Ждем завершения отмененных задач
                    loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
            except Exception as e:
                log_info(f"Error closing tasks: {e}")
            finally:
                loop.close()
                log_info("Bot thread closed and event loop freed")


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


# Глобальная переменная для хранения ссылки на приложение бота
bot_application = None

def signal_handler(signum, frame):
    """Обработчик сигналов завершения"""
    log_info(f"Received signal {signum}, shutting down gracefully...")
    
    # Останавливаем веб-приложение
    try:
        from webapp_api import app
        # Flask не имеет встроенного способа остановки, но мы можем попытаться
        log_info("Web app shutdown initiated")
    except Exception as e:
        log_info(f"Error during web app shutdown: {e}")
    
    # Выходим из программы
    sys.exit(0)

if __name__ == "__main__":
    # Регистрируем обработчики сигналов
    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)
    
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
    time.sleep(2)
    
    # Запускаем веб-приложение в основном потоке
    try:
        run_webapp()
    except KeyboardInterrupt:
        log_info("Application interrupted by user")
        signal_handler(signal.SIGINT, None)

