'use strict'

const http = require('node:http')
const fs = require('node:fs/promises')
const path = require('node:path')
const { timingSafeEqual } = require('node:crypto')

const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']], ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
])

function equal(value, expected) {
  if (typeof value !== 'string' || typeof expected !== 'string' || !expected) return false
  const a = Buffer.from(value), b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function httpError(status, message) { return Object.assign(new Error(message), { status }) }

async function readJson(request) {
  if (!(request.headers['content-type'] || '').startsWith('application/json')) throw httpError(415, 'Нужен application/json')
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > 16384) throw httpError(413, 'Размер запроса превышает 16 КБ')
    chunks.push(chunk)
  }
  let result
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw httpError(400, 'Некорректный JSON') }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw httpError(400, 'Нужен JSON-объект')
  return result
}

function createHttpServer({ config, store, monitoring, registry, notifications, bot, runtime }) {
  const rate = new Map()
  let scenarioBusy = false
  function authorized(request) {
    if (config.mode === 'demo') return
    if (!equal(request.headers['x-api-key'], config.adminKey)) throw httpError(401, 'Требуется ключ администратора PulseDesk')
  }
  function validateMutation(request) {
    const origin = config.origin || `http://${request.headers.host}`
    if (request.headers.origin && request.headers.origin !== origin) throw httpError(403, 'Другой origin запрещён')
    if (request.headers['sec-fetch-site'] === 'cross-site') throw httpError(403, 'Межсайтовый запрос запрещён')
    if (config.mode === 'demo' && (request.headers.origin !== origin || request.headers['x-pulsedesk'] !== 'dashboard')) throw httpError(403, 'Используй локальный экран демонстрации')
    const key = request.socket.remoteAddress
    const now = Date.now()
    if (rate.size > 1024) for (const [id, entry] of rate) if (entry.until < now) rate.delete(id)
    const entry = rate.get(key)
    if (!entry || entry.until < now) rate.set(key, { count: 1, until: now + 60000 })
    else if (++entry.count > 40) throw httpError(429, 'Слишком много команд. Повтори через минуту.')
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader('x-content-type-options', 'nosniff')
    response.setHeader('referrer-policy', 'no-referrer')
    response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    response.setHeader('cache-control', 'no-store')
    const json = (status, payload) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(payload)) }
    try {
      if (config.mode === 'demo') {
        const hostname = new URL(`http://${request.headers.host || 'invalid'}`).hostname
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) throw httpError(403, 'Демо доступно через localhost')
      }
      const url = new URL(request.url, 'http://pulsedesk.local')
      const pathname = url.pathname
      if (request.method === 'GET' && pathname === '/health') {
        json(runtime.healthy() ? 200 : 503, { ok: runtime.healthy(), product: 'PulseDesk', mode: config.mode, lastTick: runtime.lastTick })
        return
      }
      if (request.method === 'GET' && files.has(pathname)) {
        const [filename, type] = files.get(pathname)
        const content = await fs.readFile(path.join(config.root, 'public', filename))
        response.writeHead(200, { 'content-type': type }); response.end(content); return
      }
      if (request.method === 'POST' && pathname === '/telegram/webhook') {
        if (config.mode !== 'webhook') throw httpError(404, 'Webhook отключён')
        if (!equal(request.headers['x-telegram-bot-api-secret-token'], config.webhookSecret)) throw httpError(401, 'Неверный webhook secret')
        const update = await readJson(request)
        if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) throw httpError(400, 'Некорректный update_id')
        store.acceptUpdate(update)
        // ACK only after SQLite has durably accepted this update. Worker handles it afterwards.
        json(200, { ok: true }); return
      }
      if (request.method === 'GET' && pathname === '/api/overview') { authorized(request); json(200, monitoring.overview()); return }
      if (request.method === 'GET' && pathname === '/api/modules') { json(200, { modules: registry.list(), mode: config.mode }); return }
      if (!pathname.startsWith('/api/') || request.method !== 'POST') throw httpError(404, 'Маршрут не найден')
      authorized(request)
      validateMutation(request)
      const body = await readJson(request)
      if (pathname === '/api/demo/scenario') {
        if (config.mode !== 'demo') throw httpError(404, 'Демонстрация отключена')
        if (!['healthy', 'outage', 'content', 'certificate', 'slow'].includes(body.scenario)) throw httpError(400, 'Неизвестный сценарий')
        if (scenarioBusy) throw httpError(409, 'Предыдущий сценарий ещё выполняется')
        scenarioBusy = true
        try {
          store.setSetting('demoScenario', body.scenario)
          for (let pass = 0; pass < config.failureThreshold; pass++) {
            for (const monitor of store.listMonitors().filter(m => m.enabled)) await monitoring.run(monitor.id)
          }
          await notifications.drain()
          json(200, { ok: true, scenario: body.scenario })
        } finally { scenarioBusy = false }
        return
      }
      if (pathname === '/api/demo/command') {
        if (config.mode !== 'demo') throw httpError(404, 'Демонстрация отключена')
        if (typeof body.text !== 'string' || body.text.length > 1500) throw httpError(400, 'Команда слишком длинная')
        store.addDemoMessage('in', body.text)
        await bot.handle({ message: { message_id: 1, chat: { id: 900001, type: 'private' }, from: { id: 900001 }, text: body.text } })
        json(200, { ok: true }); return
      }
      if (pathname === '/api/monitors') { const monitor = monitoring.add(body); json(201, { ok: true, monitor }); return }
      const action = /^\/api\/monitors\/([\w-]{1,50})\/(run|pause|resume)$/.exec(pathname)
      if (action) {
        const [, id, verb] = action
        if (!store.getMonitor(id)) throw httpError(404, 'Проверка не найдена')
        if (verb === 'run') await monitoring.run(id)
        else store.setEnabled(id, verb === 'resume')
        await notifications.drain()
        json(200, { ok: true }); return
      }
      const ack = /^\/api\/incidents\/([a-f0-9-]{36})\/ack$/.exec(pathname)
      if (ack) {
        if (!store.acknowledge(ack[1], config.mode === 'demo' ? 'demo-operator' : 'api-admin')) throw httpError(409, 'Инцидент уже принят или закрыт')
        json(200, { ok: true }); return
      }
      const retry = /^\/api\/deliveries\/([a-f0-9-]{36})\/retry$/.exec(pathname)
      if (retry) {
        const changed = store.retryDelivery(retry[1])
        if (!changed) throw httpError(409, 'Только недоставленное сообщение можно вернуть в очередь')
        await notifications.drain()
        json(200, { ok: true }); return
      }
      throw httpError(404, 'Маршрут не найден')
    } catch (error) {
      if (response.headersSent || response.destroyed) return
      const status = error.status || (error.code?.startsWith('ERR_SQLITE') ? 500 : 400)
      json(status, { ok: false, error: status >= 500 ? 'Внутренняя ошибка сервиса' : error.message })
    }
  })
  server.requestTimeout = 15000
  server.headersTimeout = 10000
  return server
}

module.exports = { createHttpServer, equal, readJson }
