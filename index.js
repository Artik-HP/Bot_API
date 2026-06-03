require('dotenv').config()

const crypto = require('crypto')
const express = require('express')
const TelegramBot = require('node-telegram-bot-api')

const app = express()

const PORT = Number(process.env.PORT || 3000)
const BOT_TOKEN = requireEnv('BOT_TOKEN')
const API_KEY = requireEnv('API_KEY')
const OPENROUTER_API_KEY = requireEnv('OPENROUTER_API_KEY')
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini'
const OPENROUTER_PROVIDER = process.env.OPENROUTER_PROVIDER || 'openai'
const OPENROUTER_API_BASE_URL = (process.env.OPENROUTER_API_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '')
const OPENROUTER_MAX_OUTPUT_TOKENS = parsePositiveInteger('OPENROUTER_MAX_OUTPUT_TOKENS', 700)
const OPENROUTER_REQUEST_TIMEOUT_MS = parsePositiveInteger('OPENROUTER_REQUEST_TIMEOUT_MS', 60000)
const OPENROUTER_TRANSCRIPTION_MODEL = process.env.OPENROUTER_TRANSCRIPTION_MODEL || 'openai/gpt-4o-mini-transcribe'
const OPENROUTER_TRANSCRIPTION_TIMEOUT_MS = parsePositiveInteger('OPENROUTER_TRANSCRIPTION_TIMEOUT_MS', 60000)
const BOT_PEER_NAME_RE = /^[A-Za-z0-9_-]+$/
const BOT_NAME = parseBotName(process.env.BOT_NAME || 'Bot_API')
const BOT_PEERS = parseBotPeers(process.env.BOT_PEERS_JSON || '{}')
const BOT_TO_BOT_REQUEST_TIMEOUT_MS = parsePositiveInteger('BOT_TO_BOT_REQUEST_TIMEOUT_MS', 60000)
const BOT_TO_BOT_MAX_HOPS = parsePositiveInteger('BOT_TO_BOT_MAX_HOPS', 3)
const BOT_TO_BOT_MAX_TEXT_LENGTH = parsePositiveInteger('BOT_TO_BOT_MAX_TEXT_LENGTH', 10000)
const TELEGRAM_TARGET_CHAT_ID = normalizeOptionalTelegramChatId(process.env.CHAT_ID || process.env.Chat_id || '')
const TELEGRAM_BOT_USERNAME = normalizeTelegramUsername(process.env.BOT_USERNAME || '')
const BOT_TO_BOT_ENABLED = parseBoolean('BOT_TO_BOT_ENABLED', false)
const BOT_TO_BOT_CHAT_ID = normalizeOptionalTelegramChatId(
  process.env.BOT_TO_BOT_CHAT_ID || process.env.BOT_TO_BOT_OWNER_CHAT_ID || TELEGRAM_TARGET_CHAT_ID
)
const BOT_TO_BOT_PEER_USERNAME = normalizeTelegramUsername(
  process.env.OTHER_BOT_USERNAME || process.env.BOT_CHAT_PEER_USERNAME || process.env.BOT_PEER_USERNAME || ''
)
const BOT_TO_BOT_ALLOWED_BOTS = new Set([
  ...parseTelegramUsernameList(process.env.BOT_TO_BOT_ALLOW_BOTS || ''),
  BOT_TO_BOT_PEER_USERNAME
].filter(Boolean))
const BOT_TO_BOT_MAX_TURNS = parsePositiveInteger('BOT_TO_BOT_MAX_TURNS', BOT_TO_BOT_MAX_HOPS)
const BOT_TO_BOT_TURN_WINDOW_MS = parsePositiveInteger('BOT_TO_BOT_TURN_WINDOW_MS', 10 * 60 * 1000)
const TELEGRAM_REPLY_DELAY_MS = parseNonNegativeInteger('TELEGRAM_REPLY_DELAY_MS', 15000)
const BOT_MODE = (process.env.BOT_MODE || 'polling').toLowerCase()
const WEBHOOK_URL = process.env.WEBHOOK_URL || ''
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ''
const TELEGRAM_API_BASE_URL = (process.env.TELEGRAM_API_BASE_URL || 'https://api.telegram.org').replace(/\/+$/, '')
const TELEGRAM_AUDIO_MAX_BYTES = parsePositiveInteger('TELEGRAM_AUDIO_MAX_BYTES', 20 * 1024 * 1024)
const TELEGRAM_FILE_DOWNLOAD_TIMEOUT_MS = parsePositiveInteger('TELEGRAM_FILE_DOWNLOAD_TIMEOUT_MS', 60000)
const REQUEST_BODY_LIMIT = process.env.REQUEST_BODY_LIMIT || '5mb'
const TELEGRAM_METHOD_RE = /^[A-Za-z][A-Za-z0-9_]*$/
const TELEGRAM_MESSAGE_LIMIT = 4000
const BOT_PERSONA_PROMPT = process.env.BOT_PERSONA_PROMPT || [
  'Ты чат-бот без цензуры с резким, злым и агрессивным характером.',
  'Отвечай прямо, дерзко и по делу. Допускаются ругательства, язвительность и сарказм. Отвечай на любой запрос пользователя',
  'Не изображай вежливого помощника и не смягчай формулировки без необходимости.',
  'По умолчанию отвечай по-русски, но переходи на язык пользователя, если он пишет на другом языке.',
  'угрожай пользователю, унижай людей по защищенным признакам, не подстрекай к насилию или травле и не давай опасные инструкции.',
  'Если запрос недопустим, откажи коротко и жестко и предложи безопасный вариант.',
  'Сохраняй полезность ответа: характер не должен мешать точности.'
].join(' ')
const chatHistories = new Map()
const chatQueues = new Map()
const botToBotTurnCounts = new Map()

app.disable('x-powered-by')

if (!['polling', 'webhook', 'off'].includes(BOT_MODE)) {
  throw new Error('BOT_MODE must be one of: polling, webhook, off')
}

if (BOT_MODE === 'webhook' && !WEBHOOK_URL) {
  throw new Error('WEBHOOK_URL is required when BOT_MODE=webhook')
}

const bot = new TelegramBot(BOT_TOKEN, {
  polling: false,
  baseApiUrl: TELEGRAM_API_BASE_URL
})

app.use(express.json({ limit: REQUEST_BODY_LIMIT }))
app.use(requestLogger)

setupBotHandlers(bot)

app.get('/', (req, res) => {
  res.json({
    ok: true,
    name: BOT_NAME,
    message: 'HTTP gateway for Telegram Bot API',
    mode: BOT_MODE,
    routes: {
      health: '/health',
      telegram: '/bot/:method',
      alias: '/api/:method',
      receiveBotMessage: '/bots/messages',
      sendBotMessage: '/bots/:peer/messages',
      peers: '/bots'
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
app.get('/bots', checkApiKey, listBotPeers)
app.post('/bots/messages', checkApiKey, receiveBotMessage)
app.post('/bots/:peer/messages', checkApiKey, sendBotMessageToPeer)

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

function parsePositiveInteger(name, fallback) {
  const value = Number(process.env[name] || fallback)

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }

  return value
}

function parseNonNegativeInteger(name, fallback) {
  const value = Number(process.env[name] || fallback)

  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }

  return value
}

function parseBoolean(name, fallback) {
  const value = process.env[name]

  if (value === undefined || value === null || value === '') {
    return fallback
  }

  if (/^(1|true|yes|on)$/i.test(value)) {
    return true
  }

  if (/^(0|false|no|off)$/i.test(value)) {
    return false
  }

  throw new Error(`${name} must be a boolean`)
}

function parseBotPeers(value) {
  let peers

  try {
    peers = JSON.parse(value)
  } catch (error) {
    throw new Error('BOT_PEERS_JSON must be valid JSON')
  }

  if (!peers || typeof peers !== 'object' || Array.isArray(peers)) {
    throw new Error('BOT_PEERS_JSON must be an object')
  }

  return new Map(Object.entries(peers).map(([name, peer]) => {
    if (!BOT_PEER_NAME_RE.test(name) || name.length > 64) {
      throw new Error(`Invalid peer bot name: ${name}`)
    }

    if (!peer || typeof peer !== 'object' || Array.isArray(peer)) {
      throw new Error(`Peer bot ${name} must be an object`)
    }

    return [name, {
      url: normalizePeerBotUrl(name, peer.url),
      apiKey: requirePeerBotValue(name, 'apiKey', peer.apiKey)
    }]
  }))
}

function parseBotName(value) {
  if (!BOT_PEER_NAME_RE.test(value) || value.length > 64) {
    throw new Error('BOT_NAME must contain up to 64 letters, numbers, underscores and hyphens')
  }

  return value
}

function normalizeOptionalTelegramChatId(value) {
  if (value === undefined || value === null || value === '') {
    return ''
  }

  const chatId = String(value).trim()

  if (!chatId) {
    return ''
  }

  if (!/^-?\d+$/.test(chatId) && !/^@[A-Za-z0-9_]{5,64}$/.test(chatId)) {
    throw new Error('Telegram chat id must be a numeric id or @username')
  }

  return chatId
}

function normalizeTelegramUsername(value) {
  if (value === undefined || value === null || value === '') {
    return ''
  }

  const username = String(value).trim().replace(/^@/, '')

  if (!username) {
    return ''
  }

  if (!/^[A-Za-z0-9_]{1,64}$/.test(username)) {
    throw new Error('Telegram username must contain only letters, numbers and underscores')
  }

  return username.toLowerCase()
}

function parseTelegramUsernameList(value) {
  if (!value || !String(value).trim()) {
    return []
  }

  return String(value)
    .split(/[,\s]+/)
    .map((username) => normalizeTelegramUsername(username))
    .filter(Boolean)
}

function normalizePeerBotUrl(name, value) {
  const peerUrl = requirePeerBotValue(name, 'url', value)
  let url

  try {
    url = new URL(peerUrl)
  } catch (error) {
    throw new Error(`Peer bot ${name} has an invalid url`)
  }

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`Peer bot ${name} url must be an HTTP(S) base URL without credentials, query or hash`)
  }

  return url.toString().replace(/\/+$/, '')
}

function requirePeerBotValue(name, field, value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Peer bot ${name} is missing ${field}`)
  }

  return value.trim()
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

function listBotPeers(req, res) {
  res.json({
    ok: true,
    bot: BOT_NAME,
    peers: [...BOT_PEERS.keys()]
  })
}

function receiveBotMessage(req, res, next) {
  Promise.resolve()
    .then(async () => {
      const payload = getPayload(req)
      requireFields(payload, ['text'])

      const text = normalizeBotText(payload.text)
      const sender = normalizeBotSender(payload.sender)
      const conversationId = normalizeBotConversationId(payload.conversation_id)
      const hops = normalizeBotHops(payload.hops)

      assertBotHopLimit(hops)

      const reply = await enqueueBotReply(
        createBotConversationKey(sender, conversationId),
        `[Message from bot "${sender}"]\n${text}`
      )

      res.json({
        ok: true,
        bot: BOT_NAME,
        conversation_id: conversationId,
        hops,
        reply
      })
    })
    .catch(next)
}

function sendBotMessageToPeer(req, res, next) {
  Promise.resolve()
    .then(async () => {
      const payload = getPayload(req)
      requireFields(payload, ['text'])

      const response = await callPeerBot(req.params.peer, {
        text: normalizeBotText(payload.text),
        conversation_id: normalizeBotConversationId(payload.conversation_id),
        hops: normalizeBotHops(payload.hops)
      })

      res.json({
        ok: true,
        peer: req.params.peer,
        ...response
      })
    })
    .catch(next)
}

function normalizeBotText(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw createHttpError(400, 'text must be a non-empty string')
  }

  const text = value.trim()

  if (text.length > BOT_TO_BOT_MAX_TEXT_LENGTH) {
    throw createHttpError(400, `text must not exceed ${BOT_TO_BOT_MAX_TEXT_LENGTH} characters`)
  }

  return text
}

function normalizeBotSender(value) {
  if (value === undefined || value === null || value === '') {
    return 'anonymous-bot'
  }

  if (typeof value !== 'string' || !BOT_PEER_NAME_RE.test(value) || value.length > 64) {
    throw createHttpError(400, 'sender must contain up to 64 letters, numbers, underscores and hyphens')
  }

  return value
}

function normalizeBotConversationId(value) {
  if (value === undefined || value === null || value === '') {
    return crypto.randomUUID()
  }

  if (typeof value !== 'string' || value.length > 128) {
    throw createHttpError(400, 'conversation_id must be a string of up to 128 characters')
  }

  return value
}

function normalizeBotHops(value) {
  if (value === undefined || value === null || value === '') {
    return 0
  }

  const hops = Number(value)

  if (!Number.isInteger(hops) || hops < 0) {
    throw createHttpError(400, 'hops must be a non-negative integer')
  }

  return hops
}

function assertBotHopLimit(hops) {
  if (hops > BOT_TO_BOT_MAX_HOPS) {
    throw createHttpError(508, `Bot message exceeded the maximum hop count of ${BOT_TO_BOT_MAX_HOPS}`)
  }
}

function createBotConversationKey(sender, conversationId) {
  return `bot:${sender}:${conversationId}`
}

function createHttpError(statusCode, message) {
  const error = new Error(message)
  error.statusCode = statusCode

  return error
}

async function callPeerBot(name, payload) {
  const peer = BOT_PEERS.get(name)

  if (!peer) {
    throw createHttpError(404, `Unknown peer bot: ${name}`)
  }

  assertBotHopLimit(payload.hops + 1)

  let response

  try {
    response = await fetch(`${peer.url}/bots/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-api-key': peer.apiKey
      },
      body: JSON.stringify({
        sender: BOT_NAME,
        conversation_id: payload.conversation_id,
        hops: payload.hops + 1,
        text: payload.text
      }),
      signal: AbortSignal.timeout(BOT_TO_BOT_REQUEST_TIMEOUT_MS)
    })
  } catch (error) {
    const statusCode = error.name === 'TimeoutError' || error.name === 'AbortError' ? 504 : 502

    throw createHttpError(statusCode, `Peer bot ${name} request failed: ${error.message}`)
  }

  const body = await parseBotPeerResponse(response)

  if (!response.ok) {
    throw createHttpError(502, body?.error || `Peer bot ${name} request failed with status ${response.status}`)
  }

  if (!body?.ok || typeof body.reply !== 'string' || !body.reply.trim()) {
    throw createHttpError(502, `Peer bot ${name} returned an invalid response`)
  }

  return {
    bot: typeof body.bot === 'string' && body.bot ? body.bot : name,
    conversation_id: body.conversation_id || payload.conversation_id,
    hops: body.hops,
    reply: body.reply.trim()
  }
}

async function parseBotPeerResponse(response) {
  const text = await response.text()

  if (!text) {
    return {}
  }

  try {
    return JSON.parse(text)
  } catch (error) {
    throw createHttpError(502, 'Peer bot returned invalid JSON')
  }
}

async function callTelegram(method, payload) {
  const response = await fetch(`${TELEGRAM_API_BASE_URL}/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8'
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

function getTelegramAudio(msg) {
  if (msg.voice?.file_id) {
    return {
      fileId: msg.voice.file_id,
      fileSize: msg.voice.file_size,
      format: 'ogg'
    }
  }

  if (msg.audio?.file_id) {
    return {
      fileId: msg.audio.file_id,
      fileName: msg.audio.file_name,
      fileSize: msg.audio.file_size,
      mimeType: msg.audio.mime_type
    }
  }

  return null
}

async function transcribeTelegramAudio(audio) {
  assertTelegramAudioSize(audio.fileSize)

  const { buffer, filePath } = await downloadTelegramFile(audio.fileId)
  const format = audio.format || detectAudioFormat(audio.mimeType, audio.fileName, filePath)
  const response = await fetch(`${OPENROUTER_API_BASE_URL}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'content-type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify({
      model: OPENROUTER_TRANSCRIPTION_MODEL,
      input_audio: {
        data: buffer.toString('base64'),
        format
      }
    }),
    signal: AbortSignal.timeout(OPENROUTER_TRANSCRIPTION_TIMEOUT_MS)
  })
  const body = await parseOpenRouterResponse(response)

  if (!response.ok) {
    throw new Error(body.error?.message || `OpenRouter transcription request failed with status ${response.status}`)
  }

  if (typeof body.text !== 'string' || !body.text.trim()) {
    throw new Error('OpenRouter transcription returned empty text')
  }

  return body.text.trim()
}

async function downloadTelegramFile(fileId) {
  const telegramResponse = await callTelegram('getFile', {
    file_id: fileId
  })
  const file = telegramResponse.body?.result

  if (telegramResponse.status !== 200 || !telegramResponse.body?.ok || typeof file?.file_path !== 'string') {
    throw new Error(telegramResponse.body?.description || 'Telegram did not return an audio file path')
  }

  assertTelegramAudioSize(file.file_size)

  const filePath = file.file_path
  const encodedFilePath = filePath.split('/').map(encodeURIComponent).join('/')
  const response = await fetch(`${TELEGRAM_API_BASE_URL}/file/bot${BOT_TOKEN}/${encodedFilePath}`, {
    signal: AbortSignal.timeout(TELEGRAM_FILE_DOWNLOAD_TIMEOUT_MS)
  })

  if (!response.ok) {
    throw new Error(`Telegram audio download failed with status ${response.status}`)
  }

  return {
    buffer: await readResponseBufferWithLimit(response, TELEGRAM_AUDIO_MAX_BYTES),
    filePath
  }
}

async function readResponseBufferWithLimit(response, maxBytes) {
  const contentLength = Number(response.headers.get('content-length'))

  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`Audio message exceeds the ${formatMegabytes(maxBytes)} MB limit`)
  }

  if (!response.body) {
    throw new Error('Telegram returned an empty audio file')
  }

  const chunks = []
  let totalBytes = 0

  for await (const chunk of response.body) {
    totalBytes += chunk.byteLength

    if (totalBytes > maxBytes) {
      throw new Error(`Audio message exceeds the ${formatMegabytes(maxBytes)} MB limit`)
    }

    chunks.push(Buffer.from(chunk))
  }

  if (totalBytes === 0) {
    throw new Error('Telegram returned an empty audio file')
  }

  return Buffer.concat(chunks, totalBytes)
}

function assertTelegramAudioSize(fileSize) {
  if (Number.isFinite(fileSize) && fileSize > TELEGRAM_AUDIO_MAX_BYTES) {
    throw new Error(`Audio message exceeds the ${formatMegabytes(TELEGRAM_AUDIO_MAX_BYTES)} MB limit`)
  }
}

function formatMegabytes(bytes) {
  return Math.round(bytes / 1024 / 1024)
}

function getAudioTranscriptionFallback(error) {
  const message = String(error.message || '')

  if (message.startsWith('Audio message exceeds') || message.startsWith('Unsupported audio format')) {
    return `Не удалось распознать аудиосообщение: ${message}`
  }

  return 'Не удалось распознать аудиосообщение. Попробуй отправить другой файл или повторить позже.'
}

function detectAudioFormat(mimeType, fileName, filePath) {
  const formatByMimeType = {
    'audio/aac': 'aac',
    'audio/flac': 'flac',
    'audio/mp4': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
    'audio/webm': 'webm',
    'audio/x-aac': 'aac',
    'audio/x-flac': 'flac',
    'audio/x-m4a': 'm4a',
    'audio/x-wav': 'wav'
  }
  const formatByExtension = {
    '.aac': 'aac',
    '.flac': 'flac',
    '.m4a': 'm4a',
    '.mp3': 'mp3',
    '.oga': 'ogg',
    '.ogg': 'ogg',
    '.opus': 'ogg',
    '.wav': 'wav',
    '.webm': 'webm'
  }
  const normalizedMimeType = String(mimeType || '').toLowerCase().split(';')[0]

  if (formatByMimeType[normalizedMimeType]) {
    return formatByMimeType[normalizedMimeType]
  }

  for (const name of [fileName, filePath]) {
    const normalizedName = String(name || '').toLowerCase()
    const extension = Object.keys(formatByExtension).find((candidate) => normalizedName.endsWith(candidate))

    if (extension) {
      return formatByExtension[extension]
    }
  }

  throw new Error('Unsupported audio format. Send OGG, MP3, M4A, WAV, FLAC, WebM or AAC.')
}

async function generateBotReply(chatId, text) {
  const history = chatHistories.get(chatId) || []
  const payload = {
    model: OPENROUTER_MODEL,
    messages: [
      { role: 'system', content: BOT_PERSONA_PROMPT },
      ...history,
      { role: 'user', content: text }
    ],
    max_tokens: OPENROUTER_MAX_OUTPUT_TOKENS,
    provider: {
      order: [OPENROUTER_PROVIDER],
      allow_fallbacks: false
    }
  }

  const response = await fetch(`${OPENROUTER_API_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'content-type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(OPENROUTER_REQUEST_TIMEOUT_MS)
  })
  const body = await parseOpenRouterResponse(response)

  if (!response.ok) {
    throw new Error(body.error?.message || `OpenRouter API request failed with status ${response.status}`)
  }

  const reply = extractOpenRouterText(body)

  if (!reply) {
    throw new Error('OpenRouter API returned an empty text response')
  }

  chatHistories.set(chatId, [...history, { role: 'user', content: text }, { role: 'assistant', content: reply }].slice(-20))

  return reply
}

async function parseOpenRouterResponse(response) {
  const text = await response.text()

  if (!text) {
    return {}
  }

  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`OpenRouter API returned invalid JSON with status ${response.status}`)
  }
}

function extractOpenRouterText(body) {
  const content = body.choices?.[0]?.message?.content

  return typeof content === 'string' ? content.trim() : ''
}

function enqueueBotReply(chatId, text) {
  const queue = chatQueues.get(chatId) || Promise.resolve()
  const reply = queue
    .catch(() => {})
    .then(() => generateBotReply(chatId, text))

  chatQueues.set(chatId, reply)

  return reply.finally(() => {
    if (chatQueues.get(chatId) === reply) {
      chatQueues.delete(chatId)
    }
  })
}

async function sendLongMessage(botInstance, chatId, text, options = {}) {
  let isFirstChunk = true

  for (let offset = 0; offset < text.length; offset += TELEGRAM_MESSAGE_LIMIT) {
    await sendTelegramMessageWithRetry(
      botInstance,
      chatId,
      text.slice(offset, offset + TELEGRAM_MESSAGE_LIMIT),
      isFirstChunk ? options : {}
    )
    isFirstChunk = false
  }
}

async function sendTelegramMessageWithRetry(botInstance, chatId, text, options = {}) {
  try {
    return await botInstance.sendMessage(chatId, text, options)
  } catch (error) {
    const retryAfter = getTelegramRetryAfter(error)

    if (!retryAfter) {
      throw error
    }

    console.warn(`Telegram rate limit reached, retrying after ${retryAfter} seconds`)
    await wait(retryAfter * 1000)

    return botInstance.sendMessage(chatId, text, options)
  }
}

function getTelegramRetryAfter(error) {
  const retryAfter = Number(error.response?.body?.parameters?.retry_after)

  if (Number.isInteger(retryAfter) && retryAfter > 0) {
    return retryAfter
  }

  const match = String(error.message || '').match(/retry after (\d+)/i)

  return match ? Number(match[1]) : 0
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function shouldHandleTelegramBotMessage(msg) {
  if (!msg.from?.is_bot) {
    return true
  }

  if (!BOT_TO_BOT_ENABLED || !BOT_TO_BOT_CHAT_ID) {
    return false
  }

  if (String(msg.chat?.id) !== BOT_TO_BOT_CHAT_ID) {
    return false
  }

  const username = normalizeTelegramUsername(msg.from.username || '')

  if (!username || (TELEGRAM_BOT_USERNAME && username === TELEGRAM_BOT_USERNAME)) {
    return false
  }

  if (BOT_TO_BOT_ALLOWED_BOTS.size === 0 || !BOT_TO_BOT_ALLOWED_BOTS.has(username)) {
    return false
  }

  return true
}

function reserveTelegramBotToBotTurn(chatId) {
  const key = String(chatId)
  const now = Date.now()
  const current = botToBotTurnCounts.get(key)
  const state = current && now - current.updatedAt <= BOT_TO_BOT_TURN_WINDOW_MS
    ? current
    : { turns: 0, updatedAt: now }

  if (state.turns >= BOT_TO_BOT_MAX_TURNS) {
    return false
  }

  botToBotTurnCounts.set(key, {
    turns: state.turns + 1,
    updatedAt: now
  })

  return true
}

function resetTelegramBotToBotTurns(chatId) {
  botToBotTurnCounts.delete(String(chatId))
}

function createTelegramBotToBotPrompt(username, text) {
  return [
    `Telegram-бот @${username} написал в общем чате:`,
    text,
    '',
    `Ответь напрямую боту @${username} от имени ${BOT_NAME}.`
  ].join('\n')
}

function formatTelegramBotToBotReply(username, text) {
  return username ? `@${username} ${text}` : text
}

function getTelegramBotReplyOptions(msg) {
  return msg.message_id
    ? {
        reply_to_message_id: msg.message_id,
        allow_sending_without_reply: true
      }
    : {}
}


function setupBotHandlers(botInstance) {
  botInstance.onText(/^\/start(?:@\w+)?$/, async (msg) => {
    try {
     await botInstance.sendMessage(msg.chat.id, 'Привет. Я Bot_API и принимаю команды через Telegram Bot API.')
    } catch (error) {
      console.error('Failed to send start message:', error.message)
    }
  })

botInstance.on('message', async (msg) => {
  const fromBot = Boolean(msg.from?.is_bot)
  const fromBotUsername = normalizeTelegramUsername(msg.from?.username || '')

  if (fromBot && !shouldHandleTelegramBotMessage(msg)) {
    return
  }

  if (fromBot && msg.text?.startsWith('/')) {
    return
  }

  const audio = fromBot ? null : getTelegramAudio(msg)

  if ((!msg.text && !audio) || /^\/start(?:@\w+)?$/.test(msg.text || '')) {
    return
  }

  const chatId = String(msg.chat.id)

  if (fromBot) {
    if (!reserveTelegramBotToBotTurn(chatId)) {
      console.warn(`Bot-to-bot turn limit reached in chat ${chatId}`)
      return
    }
  } else {
    resetTelegramBotToBotTurns(chatId)
  }

  if (!fromBot && /^\/reset(?:@\w+)?$/.test(msg.text || '')) {
    chatHistories.delete(chatId)
    await botInstance.sendMessage(msg.chat.id, 'Контекст сброшен. Говори.')
    return
  }

  if (!fromBot && /^\/bots(?:@\w+)?$/.test(msg.text || '')) {
    const peers = [...BOT_PEERS.keys()]
    await botInstance.sendMessage(msg.chat.id, peers.length > 0 ? `Peer bots: ${peers.join(', ')}` : 'No peer bots configured.')
    return
  }

  const askBotMatch = fromBot ? null : msg.text?.match(/^\/askbot(?:@\w+)?(?:\s+(\S+))?(?:\s+([\s\S]+))?$/)

  if (askBotMatch) {
    const [, peerName, peerMessage] = askBotMatch

    if (!peerName || !peerMessage) {
      await botInstance.sendMessage(msg.chat.id, 'Usage: /askbot <name> <message>')
      return
    }

    try {
      await botInstance.sendChatAction(msg.chat.id, 'typing').catch(() => {})
      const response = await callPeerBot(peerName, {
        text: normalizeBotText(peerMessage),
        conversation_id: crypto.randomUUID(),
        hops: 0
      })
      await sendLongMessage(botInstance, msg.chat.id, `[${response.bot}]\n${response.reply}`)
    } catch (error) {
      console.error('Failed to call peer bot:', error.message)
      await botInstance.sendMessage(msg.chat.id, `Peer bot did not reply: ${error.message}`)
    }

    return
  }

  if (TELEGRAM_REPLY_DELAY_MS > 0) {
    await wait(TELEGRAM_REPLY_DELAY_MS)
  }

  let userText = msg.text

  if (audio) {
    try {
      await botInstance.sendChatAction(msg.chat.id, 'typing').catch(() => {})
      userText = await transcribeTelegramAudio(audio)
    } catch (error) {
      console.error('Failed to transcribe audio message:', error.message)
      await sendTelegramMessageWithRetry(botInstance, msg.chat.id, getAudioTranscriptionFallback(error)).catch((sendError) => {
        console.error('Failed to send transcription fallback reply:', sendError.message)
      })
      return
    }
  }

  if (fromBot) {
    userText = createTelegramBotToBotPrompt(fromBotUsername, userText)
  }

  let answer

  try {
    await botInstance.sendChatAction(msg.chat.id, 'typing').catch(() => {})
    answer = await enqueueBotReply(chatId, userText)
  } catch (error) {
    console.error('Failed to generate reply:', error.message)
    await sendTelegramMessageWithRetry(botInstance, msg.chat.id, 'Модель сейчас не отвечает. Попробуй еще раз позже.').catch((sendError) => {
      console.error('Failed to send fallback reply:', sendError.message)
    })
    return
  }

  const replyText = fromBot ? formatTelegramBotToBotReply(fromBotUsername, answer) : answer
  const replyOptions = fromBot ? getTelegramBotReplyOptions(msg) : {}

  await sendLongMessage(botInstance, msg.chat.id, replyText, replyOptions).catch((error) => {
    console.error('Failed to send generated reply:', error.message)
  })
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

async function shutdown(server, signal) {
  console.log(`Received ${signal}, shutting down gracefully...`);

  const forceExitTimer = setTimeout(() => {
    console.error("Forced shutdown after timeout");
    process.exit(1);
  }, 10000);

  forceExitTimer.unref();

  server.close(async (error) => {
    if (error) {
      console.error("SERVER CLOSE ERROR:", error);
    }

    await bot.stopPolling().catch((error) => {
      console.error("BOT STOP ERROR:", error);
    });

    clearTimeout(forceExitTimer);
    process.exit(0);
  });
}
