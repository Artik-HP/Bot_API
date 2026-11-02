'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { Store } = require('../src/core/store.cjs')
const { MonitoringService } = require('../src/core/monitoring.cjs')
const { NotificationWorker } = require('../src/core/notifications.cjs')
const { createRegistry } = require('../src/modules/index.cjs')
const { readConfig } = require('../src/config.cjs')
const { isPublicIp, validateUrl, resolvePublic, pinnedLookup } = require('../src/core/network.cjs')
const { TelegramTransport, TelegramError } = require('../src/adapters/telegram.cjs')

function fixture(t, extra = {}) {
  const store = new Store()
  t.after(() => store.close())
  const config = { ...readConfig({}), mode: 'polling', ...extra }
  const registry = createRegistry()
  const responses = { status: 200, text: 'Оставить заявку', latencyMs: 140 }
  const transport = { http: async () => ({ ...responses }), tls: async () => ({ expiresAt: Date.now() + 30 * 86400000, latencyMs: 40 }) }
  const service = new MonitoringService({ store, registry, transport, config })
  const monitor = service.add({ kind: 'http', name: 'Тестовый сайт', target: 'https://example.com' })
  return { store, service, monitor, registry, responses, config }
}

test('single failure is confirmed; repeated failures notify once; recovery closes and notifies once', async t => {
  const { store, service, monitor, responses } = fixture(t)
  store.subscribe('42')
  await service.run(monitor.id)
  responses.status = 503
  await service.run(monitor.id)
  assert.equal(store.incidents().length, 0)
  assert.equal(store.getMonitor(monitor.id).failures, 1)
  await service.run(monitor.id)
  await service.run(monitor.id)
  assert.equal(store.incidents().length, 1)
  assert.equal(store.deliveries().length, 1)
  assert.equal(store.getMonitor(monitor.id).status, 'down')
  const incident = store.incidents()[0]
  assert.equal(store.acknowledge(incident.id, 'operator'), true)
  assert.equal(store.acknowledge(incident.id, 'other'), false)
  responses.status = 200
  await service.run(monitor.id)
  await service.run(monitor.id)
  assert.ok(store.incidents()[0].resolved_at)
  assert.equal(store.getMonitor(monitor.id).status, 'up')
  assert.equal(store.deliveries().length, 2)
  responses.status = 503
  await service.run(monitor.id)
  await service.run(monitor.id)
  assert.equal(store.incidents().length, 2)
  assert.notEqual(store.incidents()[0].id, incident.id)
})

test('incident and its notifications commit atomically', t => {
  const { store, monitor } = fixture(t)
  store.subscribe('42')
  const queue = store.queue.bind(store)
  store.queue = () => { throw new Error('Simulated storage failure') }
  assert.throws(() => store.recordCheck(monitor.id, { healthy: false, summary: 'HTTP 503' }, 1))
  assert.equal(store.incidents().length, 0)
  assert.equal(store.history(monitor.id).length, 0)
  assert.equal(store.getMonitor(monitor.id).failures, 0)
  store.queue = queue
})

test('monitor state, incident, inbox, and queued delivery survive database reopen', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pulsedesk-storage-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'state.sqlite')
  let store = new Store(file)
  const monitor = store.addMonitor({ kind: 'http', name: 'Сайт', target: 'https://example.com/', config: {}, intervalSeconds: 60 })
  store.subscribe('42')
  store.recordCheck(monitor.id, { healthy: false, summary: 'HTTP 503' }, 1)
  store.acceptUpdate({ update_id: 100, message: { text: '/status' } })
  store.close()
  store = new Store(file)
  try {
    assert.equal(store.getMonitor(monitor.id).status, 'down')
    assert.equal(store.incidents().length, 1)
    assert.equal(store.deliveries()[0].state, 'pending')
    assert.equal(store.nextUpdate().update_id, 100)
    assert.equal(store.acceptUpdate({ update_id: 100 }), false)
    assert.equal(store.offset(), 101)
  } finally { store.close() }
})

test('a second runtime cannot take an active lease; stale lease can be reclaimed', t => {
  const { store } = fixture(t)
  assert.equal(store.claimLease('a', 1000), true)
  assert.equal(store.claimLease('b', 2000), false)
  assert.equal(store.claimLease('a', 3000), true)
  assert.equal(store.claimLease('b', 63001), true)
  store.releaseLease('a')
  assert.equal(store.claimLease('c', 63002), false)
})

test('notification worker honors Telegram retry_after and recovers delivery', async t => {
  const { store, monitor } = fixture(t)
  store.subscribe('42')
  store.recordCheck(monitor.id, { healthy: false, summary: 'HTTP 503' }, 1)
  let calls = 0
  const worker = new NotificationWorker(store, { async sendMessage() { if (++calls === 1) throw new TelegramError(429, 30) } })
  await worker.drain()
  const failed = store.deliveries()[0]
  assert.equal(failed.state, 'pending')
  assert.equal(failed.attempts, 1)
  assert.equal(store.claimDelivery(Date.now()), null)
  const item = store.claimDelivery(Date.now() + 31000)
  assert.equal(item.attempts, 2)
  store.finishDelivery(item.id)
  assert.equal(store.deliveries()[0].state, 'sent')
})

test('five unsuccessful attempts move to dead queue; manual retry resets attempts', t => {
  const { store, monitor } = fixture(t)
  store.subscribe('42')
  store.recordCheck(monitor.id, { healthy: false, summary: 'HTTP 503' }, 1, 1000)
  for (let i = 1; i <= 5; i++) {
    const item = store.claimDelivery(1000 + i * 600000)
    assert.equal(item.attempts, i)
    store.failDelivery(item, 'NETWORK_ERROR', 0, 1000 + i * 600000)
  }
  const item = store.deliveries()[0]
  assert.equal(item.state, 'dead')
  assert.equal(store.claimDelivery(99999999), null)
  assert.equal(store.retryDelivery(item.id), true)
  assert.equal(store.claimDelivery().attempts, 1)
})

test('unsubscribe cancels queued notifications and prevents future notifications', t => {
  const { store, monitor } = fixture(t)
  store.subscribe('42')
  store.recordCheck(monitor.id, { healthy: false, summary: 'HTTP 503' }, 1)
  store.unsubscribe('42')
  assert.equal(store.deliveries()[0].state, 'cancelled')
  store.recordCheck(monitor.id, { healthy: true, summary: 'HTTP 200' }, 1)
  assert.equal(store.deliveries().length, 1)
})

test('expired delivery claim is resumed after a crash', t => {
  const { store, monitor } = fixture(t)
  store.subscribe('42')
  store.recordCheck(monitor.id, { healthy: false, summary: 'HTTP 503' }, 1, 1000)
  const item = store.claimDelivery(2000)
  assert.equal(store.claimDelivery(3000), null)
  const reclaimed = store.claimDelivery(62001)
  assert.equal(reclaimed.id, item.id)
  assert.equal(reclaimed.attempts, 2)
})

test('parallel manual runs share one probe and paused checks perform no network work', async t => {
  const { store, service, monitor } = fixture(t)
  let calls = 0
  service.transport.http = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 15)); return { status: 200, latencyMs: 10 } }
  await Promise.all([service.run(monitor.id), service.run(monitor.id), service.run(monitor.id)])
  assert.equal(calls, 1)
  assert.equal(store.history(monitor.id).length, 1)
  store.setEnabled(monitor.id, false)
  await assert.rejects(service.run(monitor.id), /паузе/)
  await service.due()
  assert.equal(calls, 1)
})

test('content loss and expiring certificate open independent incidents', async t => {
  const { store, service, responses } = fixture(t, { failureThreshold: 1 })
  const content = service.add({ kind: 'content', name: 'Кнопка', target: 'https://example.com/', config: { text: 'Оставить заявку' } })
  const cert = service.add({ kind: 'tls', name: 'SSL', target: 'https://example.com', config: { warningDays: 14 } })
  responses.text = 'maintenance'
  service.transport.tls = async () => ({ expiresAt: Date.now() + 5 * 86400000, latencyMs: 40 })
  await service.run(content.id)
  await service.run(cert.id)
  assert.equal(store.incidents().length, 2)
  assert.match(store.getMonitor(cert.id).summary, /[45] дн/)
})

test('new plugin can be registered and scheduled without changes to monitoring core', async t => {
  const { store, service, registry } = fixture(t, { failureThreshold: 1 })
  registry.register({ id: 'custom', title: 'Custom', command: '/custom', validate: input => ({ target: input.target, config: {} }), check: async () => ({ healthy: false, summary: 'Custom failure' }) })
  const monitor = service.add({ kind: 'custom', name: 'Новый модуль', target: 'resource:demo' })
  await service.run(monitor.id)
  assert.equal(store.incidents()[0].summary, 'Custom failure')
  assert.ok(registry.list().some(module => module.id === 'custom'))
  assert.throws(() => registry.register(registry.get('custom')), /уже/)
})

test('history retention bounds checks per monitor', t => {
  const { store, monitor } = fixture(t)
  for (let i = 0; i < 730; i++) store.recordCheck(monitor.id, { healthy: true, summary: 'OK', latencyMs: 4 }, 2, i)
  assert.equal(store.db.prepare('SELECT COUNT(*) AS total FROM checks').get().total, 720)
})

test('monitors validate payloads and enforce configured cap', t => {
  const { service } = fixture(t, { maxMonitors: 2 })
  assert.throws(() => service.add({ kind: 'content', name: 'No phrase', target: 'https://example.org' }), /фраза/)
  assert.throws(() => service.add({ kind: 'http', name: 'Duplicate', target: 'https://example.com' }), /уже добавлена/)
  service.add({ kind: 'tls', name: 'TLS', target: 'https://example.org' })
  assert.throws(() => service.add({ kind: 'http', name: 'Third', target: 'https://example.net' }), /лимит/)
})

test('production mode refuses missing credentials and empty authorization list', () => {
  assert.equal(readConfig({ BOT_TOKEN: 'legacy-token', API_KEY: 'legacy-key' }).mode, 'demo')
  assert.throws(() => readConfig({ PULSE_MODE: 'polling' }), /PULSE_BOT_TOKEN/)
  assert.throws(() => readConfig({ PULSE_MODE: 'polling', PULSE_BOT_TOKEN: `123:${'a'.repeat(30)}` }), /PULSE_ALLOWED_USER_IDS/)
  assert.throws(() => readConfig({ PULSE_MODE: 'demo', PULSE_HOST: '0.0.0.0' }), /loopback/)
  assert.throws(() => readConfig({ PULSE_MODE: 'demo', PULSE_INTERVAL_SECONDS: 'NaN' }), /PULSE_INTERVAL/)
  const valid = { PULSE_MODE: 'webhook', PULSE_BOT_TOKEN: `123:${'a'.repeat(30)}`, PULSE_ALLOWED_USER_IDS: '42', PULSE_ADMIN_API_KEY: 'x'.repeat(40), PULSE_PUBLIC_ORIGIN: 'https://example.com' }
  assert.throws(() => readConfig(valid), /PULSE_WEBHOOK_SECRET/)
})

test('URL and IP policy reject private, mapped, non-HTTPS, credential and query targets', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.20.0.1', '169.254.169.254', '100.64.0.1', '192.168.1.1', '0.0.0.0', '224.1.1.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::']) assert.equal(isPublicIp(ip), false, ip)
  for (const ip of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) assert.equal(isPublicIp(ip), true, ip)
  for (const url of ['http://example.com', 'https://127.1', 'https://0x7f000001', 'https://[::ffff:127.0.0.1]', 'https://example.com:8443', 'https://a:b@example.com', 'https://example.com/?key=secret', 'https://localhost', 'https://host.local', 'file:///etc/passwd']) assert.throws(() => validateUrl(url), undefined, url)
  await assert.rejects(resolvePublic('https://example.com', async () => [{ address: '1.1.1.1', family: 4 }, { address: '127.0.0.1', family: 4 }]), /DNS/)
  const resolved = await resolvePublic('https://example.com', async () => [{ address: '1.1.1.1', family: 4 }])
  assert.equal(resolved.record.address, '1.1.1.1')
  pinnedLookup(resolved.record)('example.com', { all: true }, (error, records) => { assert.ifError(error); assert.deepEqual(records, [{ address: '1.1.1.1', family: 4 }]) })
})

test('Telegram errors never expose token or remote error description', async () => {
  const token = 'SECRET_TEST_TOKEN'
  const transport = new TelegramTransport(token, async () => ({ ok: false, status: 429, json: async () => ({ ok: false, error_code: 429, description: `https://api.telegram.org/bot${token}`, parameters: { retry_after: 17 } }) }))
  await assert.rejects(transport.sendMessage('42', 'Hi'), error => error.code === '429' && error.retryAfter === 17 && !error.message.includes(token))
})

test('stopping cancels an in-flight probe without creating a false incident', async t => {
  const { store, service, monitor } = fixture(t, { failureThreshold: 1 })
  let started
  const ready = new Promise(resolve => { started = resolve })
  service.transport.http = (_target, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    started()
  })
  const check = service.run(monitor.id)
  await ready
  service.stop()
  assert.equal(await check, null)
  assert.equal(store.incidents().length, 0)
  assert.equal(store.history(monitor.id).length, 0)
})

test('forcing demo never reuses the configured live database', () => {
  const config = readConfig({ PULSE_MODE: 'polling', PULSE_DATABASE: 'data/private-live.sqlite' }, { demo: true })
  assert.match(config.database, /pulsedesk-demo\.sqlite$/)
  assert.doesNotMatch(config.database, /private-live/)
})
