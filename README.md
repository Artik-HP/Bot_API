# Bot_API

Bot_API — это HTTP-шлюз к Telegram Bot API и одновременно простой Telegram-бот.

Сервер принимает защищённые API-ключом HTTP-запросы, пересылает их в Telegram Bot API и возвращает ответ Telegram почти без изменений. Для публичного webhook нужен HTTPS-адрес, но TLS обычно должен завершаться на платформе деплоя или reverse proxy, а сам Node.js-сервер слушает обычный HTTP-порт.

## Возможности

- Универсальный маршрут `/bot/:method` для любого метода Telegram Bot API
- Алиас `/api/:method`
- Удобные маршруты `/getMe`, `/sendMessage`, `/sendPhoto`, `/setCommands`, `/sendDocument`, `/sendSticker`, `/deleteMessage`, `/banUser`, `/unbanUser`, `/getUpdates`, `/getChat/:chatId`
- Авторизация через `x-api-key`, `Authorization: Bearer ...` или `api_key`
- Режимы `polling`, `webhook` и `off`
- Проверка здоровья сервера через `/health`
- JSON-ошибки и ограничение размера body через `REQUEST_BODY_LIMIT`

## Установка

```bash
pnpm install
```

Создай `.env` по примеру:

```bash
copy .env.example .env
```

Минимальные настройки:

```env
BOT_TOKEN=your_telegram_bot_token
API_KEY=your_private_api_key
OPENROUTER_API_KEY=your_openrouter_api_key
OPENROUTER_MODEL=openai/gpt-4o-mini
OPENROUTER_PROVIDER=openai
OPENROUTER_TRANSCRIPTION_MODEL=openai/gpt-4o-mini-transcribe
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

## Режимы работы

`BOT_MODE=polling` — бот получает updates через long polling и отвечает в Telegram.

`BOT_MODE=webhook` — бот принимает updates на `POST /telegram/webhook`. В `.env` нужно указать публичный HTTPS URL:

```env
BOT_MODE=webhook
WEBHOOK_URL=https://your-domain.example/telegram/webhook
WEBHOOK_SECRET=long_random_secret
```

`BOT_MODE=off` — сервер отдаёт HTTP API, но не получает входящие сообщения от Telegram. Удобно для локальных smoke-тестов.

## Примеры запросов

Проверить сервер:

```bash
curl http://localhost:3000/health
```

Получить информацию о боте:

```bash
curl -H "x-api-key: your_private_api_key" http://localhost:3000/getMe
```

Отправить сообщение через универсальный API:

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
curl.exe -X POST http://localhost:3000/setCommands ^
  -H "content-type: application/json" ^
  -H "x-api-key: api_1zx94an7j8I9o0plll" ^
  -d "{\"commands\":[{\"command\":\"start\",\"description\":\"Start bot\"}]}"
```

## Универсальный API

Любой метод Telegram Bot API можно вызвать так:

```text
POST /bot/<TelegramMethod>
POST /api/<TelegramMethod>
```

Для `GET`-запросов параметры берутся из query string. Для `POST`-запросов параметры можно передавать в JSON body и query string; `api_key` из query не пересылается в Telegram.

Пример:

```bash
curl -X POST http://localhost:3000/bot/sendMessage ^
  -H "content-type: application/json" ^
  -H "x-api-key: your_private_api_key" ^
  -d "{\"chat_id\":\"123456789\",\"text\":\"Works\"}"
```

## Telegram-бот

В режимах `polling` и `webhook` бот также обрабатывает входящие сообщения:

- `/start` — отправляет приветствие
- `/reset` — сбрасывает контекст диалога
- любой другой текст — отправляет модели через OpenRouter и отвечает с заданным характером

По умолчанию используется `openai/gpt-4o-mini` с маршрутизацией к провайдеру `openai`. Модель можно поменять через `OPENROUTER_MODEL`, провайдера — через `OPENROUTER_PROVIDER`, а промпт характера — через `BOT_PERSONA_PROMPT`.

## Аудиосообщения

Telegram-бот принимает голосовые сообщения и аудиофайлы. Он скачивает файл из Telegram, распознаёт речь через OpenRouter STT и передаёт полученный текст существующей чат-модели.

По умолчанию используется модель распознавания `openai/gpt-4o-mini-transcribe`. Модель и ограничения можно изменить в `.env`:


OPENROUTER_TRANSCRIPTION_MODEL=openai/gpt-4o-mini-transcribe
OPENROUTER_TRANSCRIPTION_TIMEOUT_MS=60000
TELEGRAM_AUDIO_MAX_BYTES=20971520
TELEGRAM_FILE_DOWNLOAD_TIMEOUT_MS=60000


## TLS и сертификаты

Node.js-сервер слушает HTTP. Для публичного webhook используй HTTPS на стороне платформы деплоя, nginx, Caddy, Cloudflare Tunnel, Render или другого proxy.

Локальные `key.pem` и `cert.pem` не нужны для запуска этого приложения и добавлены в `.gitignore`, чтобы приватные ключи не попали в репозиторий.

## Общение между ботами

Telegram не передаёт сообщения ботов другим ботам через обычные updates чата. Поэтому приложение поддерживает отдельный защищённый HTTP-протокол для общения совместимых экземпляров.

Настрой текущий экземпляр и разрешённых peer-ботов:

```env
BOT_NAME=main
BOT_PEERS_JSON={"helper":{"url":"https://helper-bot.example.com","apiKey":"helper_private_api_key"}}
BOT_TO_BOT_REQUEST_TIMEOUT_MS=60000
BOT_TO_BOT_MAX_HOPS=3
BOT_TO_BOT_MAX_TEXT_LENGTH=10000
```

Принять сообщение от другого бота:

```bash
curl.exe -X POST http://localhost:3000/bots/messages ^
  -H "content-type: application/json" ^
  -H "x-api-key: api_1zx94an7j8I9o0plllm" ^
  -d "{\"sender\":\"helper\",\"conversation_id\":\"demo-1\",\"text\":\"Hello\"}"
``
$body = @{
    sender = "@artik_ai_helper_bot"
    conversation_id = "demo-1"
    text = "Hello"
} | ConvertTo-Jsonnpmm

Invoke-RestMethod `
  -Uri "http://localhost:3000/bots/messages" `
  -Method POST `
  -Headers @{ "x-api-key" = "api_1zx94an7j8I9o0plllm" } `
  -ContentType "application/json" `
  -Body $body`

Отправить сообщение разрешённому peer-боту:

```bash
curl -X POST http://localhost:3000/bots/helper/messages ^
  -H "content-type: application/json" ^
  -H "x-api-key: your_private_api_key" ^
  -d "{\"conversation_id\":\"demo-1\",\"text\":\"Hello from main\"}"
```

Список доступных peer-ботов возвращает `GET /bots`. Из Telegram можно использовать команды `/bots` и `/askbot <имя> <сообщение>`.
