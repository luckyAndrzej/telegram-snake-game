"""
Модуль для работы с Crypto Pay API
"""

import requests
from typing import Optional, Dict
from config import CRYPTO_PAY_API_TOKEN, CRYPTO_PAY_API_URL, GAME_PRICE_USD
from logger import log_error, log_info, UserLogger


class CryptoPayAPI:
    """Класс для работы с Crypto Pay API"""
    
    def __init__(self):
        self.api_token = CRYPTO_PAY_API_TOKEN
        self.base_url = CRYPTO_PAY_API_URL
        self.session = requests.Session()
        # Устанавливаем заголовки по умолчанию
        self.session.headers.update({
            "Crypto-Pay-API-Token": self.api_token
        })
    
    def create_invoice(self, user_id: int, amount: float = GAME_PRICE_USD) -> Optional[Dict]:
        """
        Создает счет на оплату
        
        Args:
            user_id: ID пользователя Telegram
            amount: Сумма в USD
            
        Returns:
            Dict с информацией о счете или None при ошибке
        """
        try:
            url = f"{self.base_url}/createInvoice"
            
            params = {
                "asset": "USDT",  # Используем USDT как базовую валюту
                "amount": str(amount),
                "description": f"Игра Змейка - игрок {user_id}"
            }
            
            response = self.session.post(url, json=params, timeout=10)
            
            if response.status_code == 200:
                data = response.json()
                if data.get("ok"):
                    invoice = data.get("result")
                    log_info(f"Created invoice for user {user_id}: {invoice.get('invoice_id')}")
                    return invoice
                else:
                    log_error("create_invoice", Exception(f"API error: {data}"), user_id)
                    return None
            else:
                error_text = response.text
                log_error("create_invoice", Exception(f"HTTP {response.status_code}: {error_text}"), user_id)
                return None
                
        except Exception as e:
            log_error("create_invoice", e, user_id)
            return None
    
    def check_invoice(self, invoice_id: int) -> Optional[Dict]:
        """
        Проверяет статус счета
        
        Args:
            invoice_id: ID счета
            
        Returns:
            Dict с информацией о счете или None при ошибке
        """
        try:
            url = f"{self.base_url}/getInvoices"
            
            params = {
                "invoice_ids": str(invoice_id)
            }
            
            response = self.session.post(url, json=params, timeout=10)
            
            if response.status_code == 200:
                data = response.json()
                if data.get("ok"):
                    invoices = data.get("result", {}).get("items", [])
                    if invoices:
                        invoice_info = invoices[0]
                        log_info(f"Checked invoice {invoice_id}: status={invoice_info.get('status')}, full data={invoice_info}")
                        return invoice_info
                    else:
                        log_info(f"No invoices found for invoice_id {invoice_id}")
                    return None
                else:
                    log_error("check_invoice", Exception(f"API error: {data}"))
                    return None
            else:
                error_text = response.text
                log_error("check_invoice", Exception(f"HTTP {response.status_code}: {error_text}"))
                return None
                
        except Exception as e:
            log_error("check_invoice", e)
            return None
    
    def transfer(self, user_id: int, amount: float, spend_id: str = None) -> bool:
        """
        Переводит средства пользователю
        
        Args:
            user_id: ID пользователя Telegram
            amount: Сумма для перевода
            spend_id: ID траты (для избежания дублирования)
            
        Returns:
            True если успешно, False иначе
        """
        try:
            import time
            url = f"{self.base_url}/transfer"
            
            params = {
                "user_id": user_id,
                "asset": "USDT",
                "amount": str(amount),
                "spend_id": spend_id or f"win_{user_id}_{int(time.time() * 1000)}"
            }
            
            response = self.session.post(url, json=params, timeout=10)
            
            if response.status_code == 200:
                data = response.json()
                if data.get("ok"):
                    log_info(f"Transferred {amount} USDT to user {user_id}")
                    return True
                else:
                    log_error("transfer", Exception(f"API error: {data}"), user_id)
                    return False
            else:
                error_text = response.text
                log_error("transfer", Exception(f"HTTP {response.status_code}: {error_text}"), user_id)
                return False
                
        except Exception as e:
            log_error("transfer", e, user_id)
            return False


# Глобальный экземпляр API
crypto_pay = CryptoPayAPI()

