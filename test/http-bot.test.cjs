'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const http = require('node:http')
const { createApplication } = require('../src/app.cjs')
const { readConfig } = require('../src/config.cjs')
const { Store } = require('../src/core/store.cjs')

async function running(t, mode = 'demo') {
  const config = { ...readConfig({}, { root: path.resolve(__dirname, '..') }), mode, port: 0, database: ':memory:',
    adminKey: 'test-key-'.repeat(6), allowedUsers: new Set(['42']), webhookSecret: 'secret-'.repeat(8), origin: '', token: 'TEST_ONLY' }
  const calls = []
  const telegram = {
    async call(method, payload) { calls.push({ method, payload }); return method === 'getUpdates' ? [] : true },
    async sendMessage(chat, text, options) { calls.push({ method: 'sendMessage', chat, text, options }) },
  }
  const app = createApplication(config, { ...(mode === 'demo' ? {} : { telegram }), store: new Store(), transport: mode === 'demo' ? undefined : { http: async () => ({ status: 200, text: 'ready', latencyMs: 15 }) } })
  // Use webhook mode for live HTTP tests to avoid starting polling against the mock.
  const address = await app.start()
  const base = `http://127.0.0.1:${address.port}`
  const headers = { 'content-type': 'application/json', 'x-pulsedesk': 'dashboard', origin: base, ...(mode === 'demo' ? {} : { 'x-api-key': config.adminKey }) }
  t.after(() => app.stop())
  return { app, calls, config, base, headers, post: (route, payload, extraHeaders = {}) => fetch(base + route, { method: 'POST', headers: { ...headers, ...extraHeaders }, body: JSON.stringify(payload) }) }
}

test('demo end-to-end: outage → notification → acknowledge → recovery → two outbox messages', async t => {
  const { app, base, post } = await running(t)
  let response = await fetch(base + '/api/overview')
  const initial = await response.json()
  assert.equal(initial.mode, 'demo')
  assert.equal(initial.metrics.monitors, 4)
  assert.equal(initial.metrics.openIncidents, 0)
  response = await post('/api/demo/scenario', { scenario: 'outage' })
  assert.equal(response.status, 200)
  const after = await (await fetch(base + '/api/overview')).json()
  assert.equal(after.metrics.openIncidents, 1)
  assert.equal(after.deliveries.length, 1)
  assert.equal(after.deliveries[0].state, 'sent')
  assert.ok(after.demoMessages.some(message => /Инцидент:/.test(message.text)))
  const id = after.incidents[0].id
  assert.equal((await post(`/api/incidents/${id}/ack`, {})).status, 200)
  assert.equal((await post(`/api/incidents/${id}/ack`, {})).status, 409)
  await post('/api/demo/scenario', { scenario: 'outage' })
  assert.equal(app.store.deliveries().length, 1)
  await post('/api/demo/scenario', { scenario: 'healthy' })
  assert.equal(app.store.deliveries().length, 2)
  assert.ok(app.store.incidents()[0].resolved_at)
  assert.ok(app.store.demoMessages().some(message => /Восстановлено:/.test(message.text)))
})

test('demo commands run the same bot router and subscribers can opt out', async t => {
  const { app, post } = await running(t)
  await post('/api/demo/command', { text: '/status' })
  assert.match(app.store.demoMessages().at(-1).text, /Сайт портфолио/)
  await post('/api/demo/command', { text: '/unsubscribe' })
  await post('/api/demo/scenario', { scenario: 'content' })
  assert.equal(app.store.incidents().length, 1)
  assert.equal(app.store.deliveries().length, 0)
})

test('demo refuses cross-site mutations, arbitrary targets, malformed JSON and unsupported methods', async t => {
  const { base, post, headers } = await running(t)
  assert.equal((await post('/api/demo/scenario', { scenario: 'outage' }, { origin: 'https://other.example' })).status, 403)
  assert.equal((await post('/api/demo/scenario', { scenario: 'outage' }, { 'x-pulsedesk': '' })).status, 403)
  assert.equal((await post('/api/monitors', { kind: 'http', name: 'localhost', target: 'https://127.0.0.1' })).status, 400)
  assert.equal((await fetch(base + '/api/demo/scenario', { method: 'POST', headers, body: '{oops' })).status, 400)
  assert.equal((await fetch(base + '/api/demo/scenario', { method: 'POST', headers, body: JSON.stringify({ extra: 'x'.repeat(17000) }) })).status, 413)
  assert.equal((await fetch(base + '/api/demo/scenario')).status, 404)
  assert.equal((await post('/telegram/webhook', { update_id: 1 })).status, 404)
  assert.equal((await fetch(base + '/.env')).status, 404)
  const hostStatus = await new Promise((resolve, reject) => {
    http.get(base + '/api/overview', { headers: { Host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode) }).on('error', reject)
  })
  assert.equal(hostStatus, 403)
})

test('live HTTP requires admin key; webhook uses separate secret and persists before acknowledgement', async t => {
  const { app, base, config, post } = await running(t, 'webhook')
  assert.equal((await fetch(base + '/api/overview')).status, 401)
  assert.equal((await post('/api/demo/scenario', { scenario: 'outage' })).status, 404)
  assert.equal((await post('/telegram/webhook', { update_id: 77 })).status, 401)
  const update = { update_id: 77, message: { chat: { id: 42, type: 'private' }, from: { id: 42 }, text: '/start' } }
  const hookHeaders = { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': config.webhookSecret }
  assert.equal((await fetch(base + '/telegram/webhook', { method: 'POST', headers: hookHeaders, body: JSON.stringify(update) })).status, 200)
  assert.equal(app.store.nextUpdate().update_id, 77)
  await fetch(base + '/telegram/webhook', { method: 'POST', headers: hookHeaders, body: JSON.stringify(update) })
  assert.equal(app.store.db.prepare('SELECT COUNT(*) AS total FROM telegram_updates').get().total, 1)
  await app.runtime.tick()
  assert.equal(app.store.nextUpdate(), null)
  const added = await post('/api/monitors', { kind: 'http', name: 'Мой сайт', target: 'https://example.com' })
  assert.equal(added.status, 201)
  const { monitor } = await added.json()
  assert.equal((await post(`/api/monitors/${monitor.id}/run`, {})).status, 200)
  assert.equal(app.store.getMonitor(monitor.id).status, 'up')
})

test('bot refuses unauthorized users and group chats; plugin commands add valid checks', async t => {
  const { app, calls } = await running(t, 'webhook')
  const update = (id, text, type = 'private') => ({ message: { chat: { id, type }, from: { id }, text } })
  await app.bot.handle(update(99, '/start'))
  await app.bot.handle(update(42, '/start', 'group'))
  assert.equal(calls.filter(c => c.method === 'sendMessage').length, 0)
  await app.bot.handle(update(42, '/start'))
  await app.bot.handle(update(42, '/web https://example.com | Заказы'))
  await app.bot.handle(update(42, '/watch https://example.com | ready | Форма'))
  await app.bot.handle(update(42, '/tls https://example.com | Сертификат'))
  assert.equal(app.store.listMonitors().length, 3)
  await app.bot.handle(update(42, '/web https://127.0.0.1 | Внутренняя сеть'))
  assert.match(calls.at(-1).text, /запрещены/)
  assert.equal(app.store.listMonitors().length, 3)
})

test('Telegram callback confirms incident only for an allowed private-chat user', async t => {
  const { app } = await running(t, 'webhook')
  const monitor = app.monitoring.add({ kind: 'http', name: 'Сайт', target: 'https://example.com' })
  app.store.recordCheck(monitor.id, { healthy: false, summary: 'HTTP 503' }, 1)
  const id = app.store.incidents()[0].id
  const callback = actor => ({ callback_query: { id: 'test-callback', from: { id: actor }, message: { chat: { id: actor, type: 'private' } }, data: `ack:${id}` } })
  await app.bot.handle(callback(99))
  assert.equal(app.store.incidents()[0].acknowledged_at, null)
  await app.bot.handle(callback(42))
  assert.ok(app.store.incidents()[0].acknowledged_at)
  assert.equal(app.store.incidents()[0].acknowledged_by, '42')
})

test('dashboard serves local assets with CSP and never serves source files', async t => {
  const { base } = await running(t)
  for (const route of ['/', '/styles.css', '/app.js', '/favicon.svg']) {
    const response = await fetch(base + route)
    assert.equal(response.status, 200, route)
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/)
  }
  for (const route of ['/src/config.cjs', '/README.md', '/.env.pulsedesk', '/data/pulsedesk-demo.sqlite']) assert.equal((await fetch(base + route)).status, 404)
})

test('removed Telegram users lose persisted notification subscriptions on restart', async t => {
  const store = new Store()
  store.subscribe('99')
  const monitor = store.addMonitor({ kind: 'http', name: 'Site', target: 'https://example.com', config: {}, intervalSeconds: 60 })
  store.recordCheck(monitor.id, { healthy: false, summary: 'HTTP 503' }, 1)
  const config = { ...readConfig({}), mode: 'webhook', database: ':memory:', allowedUsers: new Set(['42']) }
  const app = createApplication(config, { store, telegram: { call: async () => true } })
  t.after(() => app.stop())
  assert.equal(store.db.prepare('SELECT COUNT(*) AS total FROM subscribers').get().total, 0)
  assert.equal(store.deliveries()[0].state, 'cancelled')
})

test('empty polling responses do not spin; stopping aborts the polling wait', async t => {
  const config = { ...readConfig({}), mode: 'polling', port: 0, database: ':memory:', allowedUsers: new Set(['42']) }
  let polls = 0
  const app = createApplication(config, { store: new Store(), telegram: { async call(method) { if (method === 'getUpdates') { polls++; return [] } return true } } })
  await app.start()
  t.after(() => app.stop())
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(polls, 1)
})
