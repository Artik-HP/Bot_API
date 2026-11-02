'use strict'

const path = require('node:path')
const fs = require('node:fs')

function integer(value, fallback, min, max, name) {
  const n = Number(value ?? fallback)
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name}: ожидается число от ${min} до ${max}`)
  return n
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
  }
}

function loadEnvironment(root) {
  const file = path.join(root, '.env.pulsedesk')
  if (fs.existsSync(file)) process.loadEnvFile(file)
}

module.exports = { readConfig, loadEnvironment }
