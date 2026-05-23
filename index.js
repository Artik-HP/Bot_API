require('dotenv').config()

const express = require('express')
const TelegramBot = require('node-telegram-bot-api')

const app = express()
app.use(express.json())

const PORT = process.env.PORT || 3000
const TOKEN = process.env.BOT_TOKEN
const API_KEY = process.env.API_KEY || '12345'

if (!TOKEN) {
  console.error('BOT_TOKEN is missing in .env')
  process.exit(1)
}

const bot = new TelegramBot(TOKEN, {
  polling: true
})

console.log('Bot started')

function checkApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key

  if (key !== API_KEY) {
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized'
    })
  }

  next()
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, 'Привет. Я API_BOT и я подключён к Telegram Bot API.')
})

bot.on('message', (msg) => {
  console.log('chat_id:', msg.chat.id)

  if (!msg.text || msg.text === '/start') return

  bot.sendMessage(msg.chat.id, `Ты написал: ${msg.text}`)
})

bot.on('polling_error', (error) => {
  console.error('Polling error:', error.message)
})

app.get('/', (req, res) => {
  res.json({
    ok: true,
    message: 'API_BOT is alive'
  })
})

app.get('/getMe', checkApiKey, async (req, res) => {
  try {
    const result = await bot.getMe()
    res.json({ ok: true, result })
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message })
  }
})

app.post('/sendMessage', checkApiKey, async (req, res) => {
  try {
    const { chat_id, text } = req.body

    if (!chat_id || !text) {
      return res.status(400).json({
        ok: false,
        error: 'chat_id and text are required'
      })
    }

    const result = await bot.sendMessage(chat_id, text)

    res.json({
      ok: true,
      result
    })
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    })
  }
})

app.post('/setCommands', checkApiKey, async (req, res) => {
  try {
    const { commands } = req.body

    if (!Array.isArray(commands)) {
      return res.status(400).json({
        ok: false,
        error: 'commands must be an array'
      })
    }

    const result = await bot.setMyCommands(commands)

    res.json({
      ok: true,
      result
    })
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    })
  }
})

app.post('/sendPhoto', checkApiKey, async (req, res) => {
  try {
    const { chat_id, photo, caption } = req.body

    if (!chat_id || !photo) {
      return res.status(400).json({
        ok: false,
        error: 'chat_id and photo are required'
      })
    }

    const result = await bot.sendPhoto(chat_id, photo, {
      caption
    })

    res.json({
      ok: true,
      result
    })
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    })
  }
})

app.listen(PORT, () => {
  console.log(`API server started on http://localhost:${PORT}`)
})
app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`)
  next()
})
