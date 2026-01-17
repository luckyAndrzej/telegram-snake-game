# Dockerfile для Node.js проекта
# Railway будет использовать Dockerfile вместо автоматического определения

FROM node:18-alpine

WORKDIR /app

# Копируем package files
COPY package*.json ./

# Устанавливаем зависимости
RUN npm ci --only=production

# Копируем остальные файлы
COPY . .

# Открываем порт
EXPOSE 3000

# Запускаем сервер
CMD ["node", "server.js"]

