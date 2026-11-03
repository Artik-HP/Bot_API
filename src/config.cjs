'use strict'

const path = require('node:path')
const fs = require('node:fs')

function integer(value, fallback, min, max, name) {
  const n = Number(value ?? fallback)
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name}: ожидается число от ${min} до ${max}`)
  return n
}

function timezone(value) {
  try { new Intl.DateTimeFormat('ru', { timeZone: value }) } catch { throw new Error('PULSE_TIMEZONE: часовой пояс IANA, например Europe/Kyiv') }
  return value
}

function choice(value, fallback, options, name) {
  const result = value || fallback
  if (!options.includes(result)) throw new Error(`${name}: ${options.join(', ')}`)
  return result
}

function readAi(env, mode) {
  const apiKey = env.PULSE_OPENROUTER_API_KEY || ''
  if (apiKey && !/^sk-or-[\w-]{20,200}$/.test(apiKey)) throw new Error('PULSE_OPENROUTER_API_KEY: ключ OpenRouter начинается с sk-or-')
  const model = env.PULSE_AI_MODEL || 'openai/gpt-6.1-sol'
  if (!/^[\w.-]{1,60}\/[\w.:-]{1,80}$/.test(model)) throw new Error('PULSE_AI_MODEL: идентификатор модели OpenRouter, например openai/gpt-6.1-sol')
  const baseUrl = (env.PULSE_AI_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '')
  if (!baseUrl.startsWith('https://')) throw new Error('PULSE_AI_BASE_URL: нужен HTTPS')
  const switcher = choice(env.PULSE_AI, 'auto', ['auto', 'off'], 'PULSE_AI')
  const digest = choice(env.PULSE_DIGEST, 'weekly', ['off', 'daily', 'weekly'], 'PULSE_DIGEST')
  return {
    enabled: Boolean(apiKey) && switcher !== 'off', apiKey, model, baseUrl,
    reasoning: choice(env.PULSE_AI_REASONING, 'low', ['none', 'minimal', 'low', 'medium', 'high'], 'PULSE_AI_REASONING'),
    timeoutMs: integer(env.PULSE_AI_TIMEOUT_MS, 45000, 5000, 120000, 'PULSE_AI_TIMEOUT_MS'),
    maxTokens: integer(env.PULSE_AI_MAX_OUTPUT_TOKENS, 1200, 200, 8000, 'PULSE_AI_MAX_OUTPUT_TOKENS'),
    dailyLimit: integer(env.PULSE_AI_DAILY_LIMIT, 150, 1, 5000, 'PULSE_AI_DAILY_LIMIT'),
    pageRecheckMinutes: integer(env.PULSE_AI_PAGE_RECHECK_MINUTES, mode === 'demo' ? 0 : 15, 0, 1440, 'PULSE_AI_PAGE_RECHECK_MINUTES'),
    // Scheduled digests go to every subscriber, so the demo never sends them on its own.
    digest: mode === 'demo' ? 'off' : digest,
    digestHour: integer(env.PULSE_DIGEST_HOUR, 9, 0, 23, 'PULSE_DIGEST_HOUR'),
  }
}

function readConfig(env = process.env, { demo = false, root = path.resolve(__dirname, '..') } = {}) {
  const mode = demo ? 'demo' : (env.PULSE_MODE || 'demo')
  if (!['demo', 'polling', 'webhook'].includes(mode)) throw new Error('PULSE_MODE: demo, polling или webhook')
  const allowedUsers = new Set((env.PULSE_ALLOWED_USER_IDS || '').split(/[\s,]+/).filter(Boolean))
  if ([...allowedUsers].some(id => !/^\d{1,16}$/.test(id))) throw new Error('PULSE_ALLOWED_USER_IDS: только числовые Telegram ID')
  const token = env.PULSE_BOT_TOKEN || ''
  const adminKey = env.PULSE_ADMIN_API_KEY || ''
  const webhookSecret = env.PULSE_WEBHOOK_SECRET || ''
  if (mode !== 'demo') {
    if (!/^\d+:[\w-]{25,}$/.test(token)) throw new Error('Укажи PULSE_BOT_TOKEN нового бота')
    if (allowedUsers.size === 0) throw new Error('Укажи PULSE_ALLOWED_USER_IDS: доступ к боту закрыт по умолчанию')
    if (adminKey.length < 32 || /replace|example|change/i.test(adminKey)) throw new Error('PULSE_ADMIN_API_KEY: нужен случайный ключ от 32 символов')
  }
  if (mode === 'webhook' && !/^[\w-]{32,256}$/.test(webhookSecret)) throw new Error('PULSE_WEBHOOK_SECRET: от 32 до 256 букв, цифр, _ или -')
  const host = env.PULSE_HOST || '127.0.0.1'
  if (mode === 'demo' && !['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('Демонстрация запускается только на loopback-интерфейсе')
  const origin = env.PULSE_PUBLIC_ORIGIN || ''
  if (origin && new URL(origin).origin !== origin) throw new Error('PULSE_PUBLIC_ORIGIN: укажи origin без пути и завершающего /')
  if (mode !== 'demo' && !['127.0.0.1', '::1', 'localhost'].includes(host) && !origin.startsWith('https://')) throw new Error('Для внешнего интерфейса нужен PULSE_PUBLIC_ORIGIN с HTTPS')
  if (mode === 'webhook' && !origin.startsWith('https://')) throw new Error('Для webhook нужен PULSE_PUBLIC_ORIGIN с HTTPS')
  return {
    root, mode, host, token, adminKey, webhookSecret, allowedUsers, origin,
    port: integer(env.PULSE_PORT, 4141, 0, 65535, 'PULSE_PORT'),
    database: path.resolve(root, mode === 'demo' ? (env.PULSE_DEMO_DATABASE || 'data/pulsedesk-demo.sqlite') : (env.PULSE_DATABASE || 'data/pulsedesk-live.sqlite')),
    intervalSeconds: integer(env.PULSE_INTERVAL_SECONDS, 60, 30, 86400, 'PULSE_INTERVAL_SECONDS'),
    failureThreshold: integer(env.PULSE_FAILURE_THRESHOLD, 2, 1, 10, 'PULSE_FAILURE_THRESHOLD'),
    maxMonitors: integer(env.PULSE_MAX_MONITORS, 30, 1, 100, 'PULSE_MAX_MONITORS'),
    tickMs: mode === 'demo' ? 5000 : 1000,
    timezone: timezone(env.PULSE_TIMEZONE || 'Europe/Kyiv'),
    ai: readAi(env, mode),
  }
}

function loadEnvironment(root) {
  const file = path.join(root, '.env.pulsedesk')
  if (fs.existsSync(file)) process.loadEnvFile(file)
}

module.exports = { readConfig, loadEnvironment }
