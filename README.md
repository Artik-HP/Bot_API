# Bot_API

Bot_API — это HTTP-шлюз к Telegram Bot API и одновременно обычный Telegram-бот.

Сервер принимает защищённые HTTP-запросы, пересылает их в Telegram Bot API и возвращает ответ Telegram почти без изменений. Дополнительно бот может работать в режиме `polling` или `webhook` и отвечать на сообщения в Telegram.

## Возможности

- Универсальный маршрут `POST /bot/:method` для любого метода Telegram Bot API
- Алиас `POST /api/:method`
- Старые удобные маршруты `/getMe`, `/sendMessage`, `/sendPhoto`, `/setCommands`
- Авторизация через `x-api-key`, `Authorization: Bearer ...` или `api_key`
- Режимы `polling`, `webhook` и `off`
- Проверка здоровья сервера через `/health`
- Единые JSON-ошибки и безопасный `.env.example`

## Установка

```bash
pnpm install
```

Создай `.env` по примеру:

```bash
copy .env.example .env
```

Заполни:

```env
BOT_TOKEN=your_telegram_bot_token
API_KEY=your_private_api_key
PORT=3000
BOT_MODE=polling
```

## Запуск

```bash
pnpm start
```

Для разработки:

```bash
pnpm dev
```

Проверка синтаксиса:

```bash
pnpm check
```

## Примеры запросов

Получить информацию о боте:

```bash
curl -H "x-api-key: your_private_api_key" http://localhost:3000/getMe
```

Отправить сообщение:

```bash
curl -X POST http://localhost:3000/bot/sendMessage ^
  -H "content-type: application/json" ^
  -H "x-api-key: your_private_api_key" ^
  -d "{\"chat_id\":\"123456789\",\"text\":\"Hello from Bot_API\"}"
```

Отправить фото по URL:

```bash
curl -X POST http://localhost:3000/bot/sendPhoto ^
  -H "content-type: application/json" ^
  -H "Authorization: Bearer your_private_api_key" ^
  -d "{\"chat_id\":\"123456789\",\"photo\":\"https://example.com/photo.jpg\",\"caption\":\"Photo\"}"
```

Установить команды:

```bash
curl -X POST http://localhost:3000/setCommands ^
  -H "content-type: application/json" ^
  -H "x-api-key: your_private_api_key" ^
  -d "{\"commands\":[{\"command\":\"start\",\"description\":\"Start bot\"}]}"
```

## Универсальный API

Любой метод Telegram Bot API можно вызвать так:

```text
POST /bot/<TelegramMethod>
POST /api/<TelegramMethod>
```

Тело запроса — JSON с параметрами метода.

Пример:

```bash
curl -X POST http://localhost:3000/bot/sendMessage ^
  -H "content-type: application/json" ^
  -H "x-api-key: your_private_api_key" ^
  -d "{\"chat_id\":\"123456789\",\"text\":\"Works\"}"
```

## Webhook-режим

Для webhook укажи публичный адрес:

```env
BOT_MODE=webhook
WEBHOOK_URL=https://your-domain.com/telegram/webhook
WEBHOOK_SECRET=long_random_secret
```

При старте сервер сам вызовет `setWebhook`. Telegram будет отправлять обновления на:

```text
POST /telegram/webhook
```

## Локальный API-only режим

Для smoke-тестов без polling:

```env
BOT_MODE=off
```

В этом режиме сервер отдаёт HTTP API, но не принимает входящие сообщения от Telegram.
