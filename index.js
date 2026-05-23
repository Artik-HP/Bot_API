require('dotenv').config()

const crypto = require('crypto')
const express = require('express')
const TelegramBot = require('node-telegram-bot-api')

const app = express()

const PORT = Number(process.env.PORT || 3000)
const BOT_TOKEN = requireEnv('BOT_TOKEN')
const API_KEY = requireEnv('API_KEY')
const BOT_MODE = (process.env.BOT_MODE || 'polling').toLowerCase()
const WEBHOOK_URL = process.env.WEBHOOK_URL || ''
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ''
const TELEGRAM_API_BASE_URL = (process.env.TELEGRAM_API_BASE_URL || 'https://api.telegram.org').replace(/\/+$/, '')
const REQUEST_BODY_LIMIT = process.env.REQUEST_BODY_LIMIT || '5mb'
const TELEGRAM_METHOD_RE = /^[A-Za-z][A-Za-z0-9_]*$/

app.disable('x-powered-by')

if (!['polling', 'webhook', 'off'].includes(BOT_MODE)) {
  throw new Error('BOT_MODE must be one of: polling, webhook, off')
}

if (BOT_MODE === 'webhook' && !WEBHOOK_URL) {
  throw new Error('WEBHOOK_URL is required when BOT_MODE=webhook')
}

const bot = new TelegramBot(BOT_TOKEN, {
  polling: false
})

app.use(express.json({ limit: REQUEST_BODY_LIMIT }))
app.use(requestLogger)

setupBotHandlers(bot)

app.get('/', (req, res) => {
  res.json({
    ok: true,
    name: 'Bot_API',
    message: 'HTTP gateway for Telegram Bot API',
    mode: BOT_MODE,
    routes: {
      health: '/health',
      telegram: '/bot/:method',
      alias: '/api/:method'
    }
  })
})

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    status: 'healthy',
    mode: BOT_MODE,
    uptime: process.uptime()
  })
})

app.post('/telegram/webhook', (req, res, next) => {
  try {
    if (BOT_MODE !== 'webhook') {
      return res.status(404).json({
        ok: false,
        error: 'Webhook receiver is disabled'
      })
    }

    if (WEBHOOK_SECRET && req.get('x-telegram-bot-api-secret-token') !== WEBHOOK_SECRET) {
      return res.status(401).json({
        ok: false,
        error: 'Invalid Telegram webhook secret'
      })
    }

    bot.processUpdate(req.body)
    res.sendStatus(200)
  } catch (error) {
    next(error)
  }
})

app.all('/bot/:method', checkApiKey, telegramMethodHandler)
app.all('/api/:method', checkApiKey, telegramMethodHandler)

app.get('/getMe', checkApiKey, legacyTelegramMethod('getMe'))
app.post('/sendMessage', checkApiKey, legacyTelegramMethod('sendMessage', ['chat_id', 'text']))
app.post('/sendPhoto', checkApiKey, legacyTelegramMethod('sendPhoto', ['chat_id', 'photo']))
app.post('/setCommands', checkApiKey, legacyTelegramMethod('setMyCommands', ['commands']))
app.post('/sendDocument', checkApiKey, legacyTelegramMethod('sendDocument', ['chat_id', 'document']))
app.post('/sendSticker', checkApiKey, legacyTelegramMethod('sendSticker', ['chat_id', 'sticker']))
app.post('/deleteMessage', checkApiKey, legacyTelegramMethod('deleteMessage', ['chat_id', 'message_id']))
app.post('/banUser', checkApiKey, legacyTelegramMethod('banChatMember', ['chat_id', 'user_id']))
app.post('/unbanUser', checkApiKey, legacyTelegramMethod('unbanChatMember', ['chat_id', 'user_id']))
app.get('/getUpdates', checkApiKey, legacyTelegramMethod('getUpdates'))
app.get('/getChat/:chatId', checkApiKey, (req, res, next) => {
  Promise.resolve()
    .then(async () => {
      const telegramResponse = await callTelegram('getChat', {
        ...cleanQuery(req.query),
        chat_id: req.params.chatId
      })

      res.status(telegramResponse.status).json(telegramResponse.body)
    })
    .catch(next)
})

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: 'Route not found'
  })
})

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error)
  }

  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({
      ok: false,
      error: 'Invalid JSON body'
    })
  }

  const statusCode = error.statusCode || 500

  res.status(statusCode).json({
    ok: false,
    error: error.message || 'Internal server error'
  })
})

start().catch((error) => {
  console.error('Startup error:', error.message)
  process.exit(1)
})

function requireEnv(name) {
  const value = process.env[name]

  if (!value) {
    throw new Error(`${name} is missing in .env`)
  }

  return value
}

function requestLogger(req, res, next) {
  console.log(`${new Date().toISOString()} ${req.method} ${redactSensitiveQuery(req.originalUrl)}`)
  next()
}

function redactSensitiveQuery(url) {
  return url.replace(/([?&]api_key=)[^&]*/gi, '$1***')
}

function checkApiKey(req, res, next) {
  const key = getRequestApiKey(req)

  if (!safeEquals(key, API_KEY)) {
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized'
    })
  }

  next()
}

function getRequestApiKey(req) {
  const authorization = req.get('authorization') || ''
  const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i)

  return req.get('x-api-key') || (bearerMatch && bearerMatch[1]) || normalizeQueryValue(req.query.api_key)
}

function safeEquals(candidate, expected) {
  if (!candidate || !expected) {
    return false
  }

  const candidateBuffer = Buffer.from(String(candidate))
  const expectedBuffer = Buffer.from(String(expected))

  return candidateBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(candidateBuffer, expectedBuffer)
}

function telegramMethodHandler(req, res, next) {
  Promise.resolve()
    .then(async () => {
      const method = validateTelegramMethod(req.params.method)
      const payload = getPayload(req)
      const telegramResponse = await callTelegram(method, payload)

      res.status(telegramResponse.status).json(telegramResponse.body)
    })
    .catch(next)
}

function legacyTelegramMethod(method, requiredFields = []) {
  return (req, res, next) => {
    Promise.resolve()
      .then(async () => {
        const payload = getPayload(req)
        requireFields(payload, requiredFields)
        const telegramResponse = await callTelegram(method, payload)

        res.status(telegramResponse.status).json(telegramResponse.body)
      })
      .catch(next)
  }
}

function validateTelegramMethod(method) {
  if (!TELEGRAM_METHOD_RE.test(method)) {
    const error = new Error('Invalid Telegram Bot API method name')
    error.statusCode = 400
    throw error
  }

  return method
}

function getPayload(req) {
  const queryPayload = cleanQuery(req.query)

  if (req.method === 'GET') {
    return queryPayload
  }

  if (req.body && (typeof req.body !== 'object' || Array.isArray(req.body))) {
    const error = new Error('JSON body must be an object')
    error.statusCode = 400
    throw error
  }

  return {
    ...queryPayload,
    ...(req.body || {})
  }
}

function cleanQuery(query) {
  return Object.entries(query).reduce((payload, [key, value]) => {
    if (key !== 'api_key') {
      payload[key] = normalizeQueryValue(value)
    }

    return payload
  }, {})
}

function normalizeQueryValue(value) {
  if (Array.isArray(value)) {
    return value[value.length - 1]
  }

  return value
}

function requireFields(payload, fields) {
  const missingFields = fields.filter((field) => {
    const value = payload[field]
    return value === undefined || value === null || value === ''
  })

  if (missingFields.length > 0) {
    const error = new Error(`${missingFields.join(', ')} required`)
    error.statusCode = 400
    throw error
  }
}

async function callTelegram(method, payload) {
  const response = await fetch(`${TELEGRAM_API_BASE_URL}/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload || {})
  })

  const body = await parseTelegramResponse(response)

  return {
    status: response.ok ? 200 : response.status,
    body
  }
}

async function parseTelegramResponse(response) {
  const text = await response.text()

  if (!text) {
    return {
      ok: response.ok
    }
  }

  try {
    return JSON.parse(text)
  } catch (error) {
    return {
      ok: false,
      description: text
    }
  }
}

function setupBotHandlers(botInstance) {
  botInstance.onText(/^\/start$/, async (msg) => {
    try {
      await botInstance.sendMessage(msg.chat.id, 'Привет. Я Bot_API и принимаю команды через Telegram Bot API.')
    } catch (error) {
      console.error('Failed to send start message:', error.message)
    }
  })

  botInstance.on('message', async (msg) => {
    if (!msg.text || msg.text === '/start') {
      return
    }

    console.log('chat_id:', msg.chat.id)

    try {
      await botInstance.sendMessage(msg.chat.id, `Ты написал: ${msg.text}`)
    } catch (error) {
      console.error('Failed to echo message:', error.message)
    }
  })

  botInstance.on('polling_error', (error) => {
    console.error('Polling error:', error.message)
  })

  botInstance.on('webhook_error', (error) => {
    console.error('Webhook error:', error.message)
  })
}

async function start() {
  if (BOT_MODE === 'webhook') {
    const webhookOptions = WEBHOOK_SECRET ? { secret_token: WEBHOOK_SECRET } : {}
    await bot.setWebHook(WEBHOOK_URL, webhookOptions)
    console.log('Telegram webhook configured')
  }

  if (BOT_MODE === 'polling') {
    await bot.deleteWebHook()
    await bot.startPolling()
    console.log('Telegram polling started')
  }

  if (BOT_MODE === 'off') {
    console.log('Telegram update receiver disabled')
  }

  const server = app.listen(PORT, () => {
    console.log(`Bot_API server started on http://localhost:${PORT}`)
  })

  process.once('SIGINT', () => shutdown(server, 'SIGINT'))
  process.once('SIGTERM', () => shutdown(server, 'SIGTERM'))
}

function shutdown(server, signal) {
  console.log(`${signal} received, shutting down`)

  const forceExitTimer = setTimeout(() => {
    console.error('Forced shutdown after timeout')
    process.exit(1)
  }, 10000)

  forceExitTimer.unref()

  server.close(async (error) => {
    if (error) {
      console.error('Failed to close HTTP server:', error.message)
    }

    if (BOT_MODE === 'polling') {
      await bot.stopPolling().catch((error) => {
        console.error('Failed to stop polling:', error.message)
      })
    }

    clearTimeout(forceExitTimer)
    process.exit(0)
  })
}
