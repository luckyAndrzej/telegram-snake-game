"""
Система логирования для бота
"""

import logging
import sys
from datetime import datetime
from typing import Optional

# Настройка системного логирования
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('bot.log', encoding='utf-8'),
        logging.StreamHandler(sys.stdout)
    ]
)

logger = logging.getLogger(__name__)


class UserLogger:
    """Класс для создания пользовательских баннеров"""
    
    @staticmethod
    def error_banner(message: str) -> str:
        """Создает красный баннер с ошибкой"""
        return f"🔴 {message}"
    
    @staticmethod
    def success_banner(message: str) -> str:
        """Создает зеленый баннер с успешным действием"""
        return f"🟢 {message}"
    
    @staticmethod
    def info_banner(message: str) -> str:
        """Создает синий баннер с информацией"""
        return f"🔵 {message}"
    
    @staticmethod
    def warning_banner(message: str) -> str:
        """Создает желтый баннер с предупреждением"""
        return f"🟡 {message}"


def log_error(func_name: str, error: Exception, user_id: Optional[int] = None):
    """Логирует ошибку с контекстом"""
    context = f"User ID: {user_id}, " if user_id else ""
    logger.error(f"{context}Function: {func_name}, Error: {type(error).__name__}: {str(error)}", exc_info=True)


def log_info(message: str, user_id: Optional[int] = None):
    """Логирует информационное сообщение"""
    context = f"User ID: {user_id}, " if user_id else ""
    logger.info(f"{context}{message}")

