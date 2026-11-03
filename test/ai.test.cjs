'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { Store } = require('../src/core/store.cjs')
const { MonitoringService } = require('../src/core/monitoring.cjs')
const { NotificationWorker } = require('../src/core/notifications.cjs')
const { createRegistry } = require('../src/modules/index.cjs')
const { readConfig } = require('../src/config.cjs')
const { BotRouter } = require('../src/bot/router.cjs')
const { createApplication } = require('../src/app.cjs')
const { OpenRouterClient, AiError } = require('../src/ai/openrouter.cjs')
const { AiService, digestSlot, allowCall } = require('../src/ai/service.cjs')
const { buildDigestData } = require('../src/ai/digest.cjs')
const { pageText } = require('../src/ai/text.cjs')
const prompts = require('../src/ai/prompts.cjs')

const today = () => new Date().toISOString().slice(0, 10)
const pricing = '<h1>Цены</h1><p>Telegram-бот — от 45 000 ₽</p><button>Оставить заявку</button>'

function replies(request) {
  return {
    incident_analysis: { summary: 'Сайт отвечает 503', cause: 'Похоже, упал backend за nginx', steps: ['Проверить процесс приложения', 'Посмотреть логи nginx'], severity: 'high' },
    page_verdict: { ok: request.user.includes('₽'), reason: request.user.includes('₽') ? 'Цены указаны' : 'Цен на странице нет' },
    monitor_suggestions: { summary: 'Страница с ценами', suggestions: [
      { kind: 'content', name: 'Кнопка заявки', value: 'Оставить заявку', why: 'Без неё нет заявок' },
      { kind: 'content', name: 'Выдумка', value: 'Этой фразы на странице нет', why: 'Модель ошиблась' },
      { kind: 'ai-page', name: 'Цены', value: 'Указаны цены в рублях', why: 'Клиент видит стоимость' },
      { kind: 'tls', name: 'SSL', value: '', why: 'Сертификат не истёк' },
    ] },
  }[request.schema?.name] ?? 'Текстовый ответ модели'
}

function fakeClient(responder = replies) {
  const calls = []
  return {
    calls,
    async complete(request) {
      calls.push(request)
      const data = await responder(request, calls.length)
      return { text: typeof data === 'string' ? data : JSON.stringify(data), data: typeof data === 'string' ? null : data, model: 'test/model', usage: { prompt: 100, completion: 40, cost: 0.0012 } }
    },
  }
}

function aiFixture(t, { responder, client = fakeClient(responder), ai: aiConfig = {} } = {}) {
  const store = new Store()
  t.after(() => store.close())
  const base = readConfig({})
  const config = { ...base, mode: 'polling', allowedUsers: new Set(['42']), ai: { ...base.ai, enabled: Boolean(client), dailyLimit: 20, pageRecheckMinutes: 0, ...aiConfig } }
  const registry = createRegistry()
  const responses = { status: 200, text: pricing, latencyMs: 120 }
  const transport = { http: async () => ({ ...responses }), tls: async () => ({ expiresAt: Date.now() + 40 * 86400000, latencyMs: 30 }) }
  const ai = new AiService({ store, client, config, registry, transport })
  const service = new MonitoringService({ store, registry, transport, config, ai })
  service.observe(event => ai.onTransition(event))
  return { store, registry, responses, transport, client, ai, service, config }
}

test('OpenRouter client sends model and schema, keeps the key in the header and never echoes provider errors', async t => {
  const seen = []
  const options = { apiKey: 'sk-or-v1-test-0000000000000000000000', model: 'openai/gpt-6.1-sol', baseUrl: 'https://openrouter.ai/api/v1', timeoutMs: 5000, maxTokens: 500, reasoning: 'low' }
  const ok = new OpenRouterClient(options, async (url, init) => {
    seen.push({ url, init })
    return new Response(JSON.stringify({ model: 'openai/gpt-6.1-sol', choices: [{ message: { content: '{"ok":true,"reason":"Цены на месте"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0002 } }), { status: 200 })
  })
  const result = await ok.complete(prompts.page({ expectation: 'Есть цены', text: 'Бот — 100 ₽' }))
  assert.deepEqual(result.data, { ok: true, reason: 'Цены на месте' })
  assert.deepEqual(result.usage, { prompt: 10, completion: 5, cost: 0.0002 })
  const body = JSON.parse(seen[0].init.body)
  assert.equal(seen[0].url, 'https://openrouter.ai/api/v1/chat/completions')
  assert.equal(body.model, 'openai/gpt-6.1-sol')
  assert.equal(body.response_format.json_schema.name, 'page_verdict')
  assert.equal(body.response_format.json_schema.strict, true)
  assert.deepEqual(body.reasoning, { effort: 'low', exclude: true })
  assert.equal(seen[0].init.headers.authorization, `Bearer ${options.apiKey}`)
  assert.ok(!seen[0].init.body.includes('sk-or-'))
  const failing = new OpenRouterClient(options, async () => new Response(JSON.stringify({ error: { code: 402, message: `Key ${options.apiKey} has no credits` } }), { status: 402 }))
  await assert.rejects(failing.complete({ system: 's', user: 'u' }), error => error.code === 'NO_CREDITS' && !error.message.includes('sk-or'))
  const cut = new OpenRouterClient(options, async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":tr' }, finish_reason: 'length' }] }), { status: 200 }))
  await assert.rejects(cut.complete(prompts.page({ expectation: 'Есть цены', text: 'x' })), { code: 'OUTPUT_LIMIT' })
})

test('page text drops markup, scripts and comments but keeps visible words and entities', () => {
  const text = pageText('<script>alert(1)</script><style>p{}</style><!-- secret --><h1>Цены&nbsp;&laquo;Бот&raquo;</h1><p>45&#160;000 &#x20BD;</p>')
  assert.equal(text, 'Цены «Бот»\n45 000 ₽')
})

test('an opened incident is analysed in the background and the analysis reaches each subscriber once', async t => {
  const { store, service, ai, responses, client } = aiFixture(t)
  store.subscribe('42')
  const monitor = service.add({ kind: 'http', name: 'Сайт', target: 'https://example.com' })
  responses.status = 503
  responses.text = '<h1>503 Service Unavailable</h1><p>nginx</p>'
  await service.run(monitor.id)
  assert.equal(store.aiJobs().length, 0)
  await service.run(monitor.id)
  assert.equal(store.aiJobs().length, 1)
  await ai.drain()
  const [incident] = store.incidents()
  assert.equal(incident.analysis.severity, 'high')
  assert.match(incident.analysis.cause, /backend/)
  assert.match(client.calls[0].user, /nginx/)
  assert.deepEqual(store.deliveries().map(item => item.kind).sort(), ['analysis', 'opened'])
  await ai.drain()
  assert.equal(client.calls.length, 1)
  assert.equal(store.aiUsage(today()).calls, 1)
  assert.equal(store.aiUsage(today()).cost, 0.0012)
})

test('AI page check catches a meaning change that a phrase check misses and calls the model only for new text', async t => {
  const { store, service, responses, client } = aiFixture(t)
  const smart = service.add({ kind: 'ai-page', name: 'Прайс', target: 'https://example.com/pricing', config: { expectation: 'Указаны цены в рублях' } })
  const phrase = service.add({ kind: 'content', name: 'Кнопка', target: 'https://example.com/pricing', config: { text: 'Оставить заявку' } })
  await service.run(smart.id)
  await service.run(smart.id)
  assert.equal(client.calls.length, 1)
  assert.equal(store.getMonitor(smart.id).status, 'up')
  responses.text = '<h1>Услуги</h1><p>Стоимость по запросу</p><button>Оставить заявку</button>'
  for (const id of [smart.id, phrase.id, smart.id, phrase.id]) await service.run(id)
  assert.equal(client.calls.length, 2)
  assert.equal(store.getMonitor(smart.id).status, 'down')
  assert.match(store.getMonitor(smart.id).summary, /условие нарушено/)
  assert.equal(store.getMonitor(phrase.id).status, 'up')
})

test('without a model, or when the model fails, the AI check degrades to availability instead of a false alarm', async t => {
  const off = aiFixture(t, { client: null })
  const monitor = off.service.add({ kind: 'ai-page', name: 'Прайс', target: 'https://example.com/pricing', config: { expectation: 'Указаны цены' } })
  await off.service.run(monitor.id)
  assert.equal(off.store.getMonitor(monitor.id).status, 'up')
  assert.match(off.store.getMonitor(monitor.id).summary, /AI не подключён/)
  const broken = aiFixture(t, { responder: () => { throw new AiError('TIMEOUT') } })
  const other = broken.service.add({ kind: 'ai-page', name: 'Прайс', target: 'https://example.com/pricing', config: { expectation: 'Указаны цены' } })
  await broken.service.run(other.id)
  assert.equal(broken.store.getMonitor(other.id).status, 'up')
  assert.match(broken.store.getMonitor(other.id).summary, /не ответила вовремя/)
  broken.responses.status = 500
  await broken.service.run(other.id)
  assert.equal(broken.store.getMonitor(other.id).failures, 1)
})

test('the daily AI limit skips extra questions and tells the user why', async t => {
  const { store, ai, client } = aiFixture(t, { ai: { dailyLimit: 1 } })
  ai.requestAnswer('42', 'Что сегодня падало?')
  ai.requestAnswer('42', 'А сейчас всё работает?')
  await ai.drain()
  assert.ok(client.calls.length <= 1)
  assert.ok(store.aiJobs().some(job => job.state === 'skipped' && job.error === 'BUDGET'))
  assert.ok(store.deliveries().some(item => /лимит/.test(item.payload.text)))
  assert.ok(store.aiUsage(today()).skipped >= 1)
})

test('the last 20% of the daily limit is reserved for incident analysis and page checks', () => {
  const allowed = (kind, calls, limit = 10) => allowCall({ kind, usage: { calls }, limit })
  assert.equal(allowed('ask', 7), true)
  assert.equal(allowed('ask', 8), false)
  assert.equal(allowed('scan', 8), false)
  assert.equal(allowed('digest', 8), false)
  assert.equal(allowed('incident', 9), true)
  assert.equal(allowed('page', 9), true)
  assert.equal(allowed('incident', 10), false)
  assert.equal(allowed('ask', 0, 1), true)
})

test('reports use daily rollups beyond raw history and fall back to a template without AI', async t => {
  const { store, service, ai } = aiFixture(t, { client: null })
  store.subscribe('42')
  const monitor = service.add({ kind: 'http', name: 'Сайт', target: 'https://example.com' })
  const now = Date.now()
  for (let i = 0; i < 800; i++) store.recordCheck(monitor.id, { healthy: i % 100 !== 0, latencyMs: 100, summary: 'HTTP 200' }, 2, now - (800 - i) * 60000)
  assert.equal(store.history(monitor.id, 1000).length, 720)
  const data = buildDigestData(store, { now, days: 7 })
  assert.equal(data.monitors[0].checks, 800)
  assert.equal(data.monitors[0].uptime, 99)
  ai.requestReport({ chatId: '42', days: 7 })
  await ai.drain()
  const [message] = store.deliveries()
  assert.equal(message.kind, 'message')
  assert.match(message.payload.text, /отчёт за 7 дн\./)
  assert.match(message.payload.text, /Сайт — 99% успешных/)
  assert.equal(store.getSetting('ai:lastReport').source, 'template')
})

test('scheduled digest waits for the first slot after start and is queued once per slot', async t => {
  let now = Date.parse('2026-11-02T06:30:00Z')
  const { store, config, registry, transport } = aiFixture(t, { ai: { digest: 'weekly', digestHour: 9 } })
  const ai = new AiService({ store, client: null, config: { ...config, timezone: 'Europe/Kyiv' }, registry, transport, now: () => now })
  assert.equal(digestSlot(now, { mode: 'weekly', hour: 9, timezone: 'Europe/Kyiv' }), 'weekly:2026-10-26')
  assert.equal(digestSlot(Date.parse('2026-11-04T08:00:00Z'), { mode: 'daily', hour: 9, timezone: 'Europe/Kyiv' }), 'daily:2026-11-04')
  ai.schedule()
  assert.equal(store.aiJobs().length, 0)
  now = Date.parse('2026-11-02T07:30:00Z')
  ai.schedule()
  ai.schedule()
  assert.equal(store.aiJobs().length, 1)
  assert.equal(store.aiJobs()[0].payload.broadcast, true)
})

test('bot queues AI requests, validates scan targets, throttles and turns suggestions into checks', async t => {
  const { store, service, ai, registry, config } = aiFixture(t)
  const sent = []
  const telegram = { async call(method, payload) { sent.push({ method, ...payload }); return true }, async sendMessage(chat, text, options) { sent.push({ chat, text, options }) } }
  const bot = new BotRouter({ store, monitoring: service, registry, telegram, config, ai })
  const say = text => bot.handle({ message: { chat: { id: 42, type: 'private' }, from: { id: 42 }, text } })
  await say('/scan http://127.0.0.1/admin')
  assert.match(sent.at(-1).text, /Разрешён публичный HTTPS/)
  await say('/scan https://example.com/pricing')
  assert.equal(store.aiJobs()[0].kind, 'scan')
  await say('/ask что падало?')
  assert.match(sent.at(-1).text, /не чаще раза в 15 секунд/)
  await ai.drain()
  const reply = store.deliveries().find(item => item.kind === 'message')
  const buttons = reply.payload.markup.inline_keyboard[0]
  assert.equal(buttons.length, 3)
  assert.doesNotMatch(reply.payload.text, /Этой фразы/)
  await bot.handle({ callback_query: { id: 'cb', data: buttons[0].callback_data, from: { id: 42 }, message: { chat: { id: 42, type: 'private' } } } })
  assert.equal(store.listMonitors().length, 1)
  assert.equal(store.listMonitors()[0].kind, 'content')
  await new NotificationWorker(store, telegram).drain()
  assert.ok(sent.some(item => item.options?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === buttons[0].callback_data))
  const quiet = aiFixture(t, { client: null })
  const offBot = new BotRouter({ store: quiet.store, monitoring: quiet.service, registry: quiet.registry, telegram, config: quiet.config, ai: quiet.ai })
  await offBot.handle({ message: { chat: { id: 42, type: 'private' }, from: { id: 42 }, text: '/ask что падало?' } })
  assert.match(sent.at(-1).text, /AI не подключён/)
})

test('AI configuration validates the OpenRouter key, model, timezone and digest options', () => {
  const key = `sk-or-v1-${'a'.repeat(64)}`
  assert.equal(readConfig({}).ai.enabled, false)
  const config = readConfig({ PULSE_OPENROUTER_API_KEY: key })
  assert.equal(config.ai.enabled, true)
  assert.equal(config.ai.model, 'openai/gpt-6.1-sol')
  assert.equal(config.ai.digest, 'off')
  assert.equal(readConfig({ PULSE_OPENROUTER_API_KEY: key, PULSE_AI: 'off' }).ai.enabled, false)
  assert.throws(() => readConfig({ PULSE_OPENROUTER_API_KEY: 'sk-proj-123' }), /sk-or-/)
  assert.throws(() => readConfig({ PULSE_AI_MODEL: 'gpt 6' }), /PULSE_AI_MODEL/)
  assert.throws(() => readConfig({ PULSE_DIGEST: 'hourly' }), /PULSE_DIGEST/)
  assert.throws(() => readConfig({ PULSE_TIMEZONE: 'Mars/Olympus' }), /PULSE_TIMEZONE/)
  assert.throws(() => readConfig({ PULSE_AI_BASE_URL: 'http://openrouter.ai/api/v1' }), /HTTPS/)
})

async function settle(app) {
  for (let i = 0; i < 20; i++) {
    if (app.runtime.aiTask) { await app.runtime.aiTask; continue }
    if (!app.store.aiJobs().some(job => ['pending', 'running'].includes(job.state))) return
    app.runtime.kickAi()
  }
}

test('demo: a lost price list is caught only by AI, analysed, and reports reach the Telegram preview', async t => {
  const config = { ...readConfig({}, { root: path.resolve(__dirname, '..') }), port: 0, database: ':memory:' }
  const client = fakeClient()
  const app = createApplication(config, { store: new Store(), aiClient: client })
  const address = await app.start()
  t.after(() => app.stop())
  // The first background tick probes due demo services; let it finish so it cannot race the scenario.
  while (!app.runtime.lastTick) await new Promise(resolve => setTimeout(resolve, 10))
  await settle(app)
  const base = `http://127.0.0.1:${address.port}`
  const post = (route, payload) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pulsedesk': 'dashboard', origin: base }, body: JSON.stringify(payload) })
  assert.equal((await post('/api/demo/scenario', { scenario: 'semantic' })).status, 200)
  await settle(app)
  const overview = await (await fetch(base + '/api/overview')).json()
  const incident = overview.incidents.find(item => !item.resolved_at)
  assert.equal(incident.monitor_name, 'Прайс и заявка (AI)')
  assert.equal(incident.analysis.severity, 'high')
  assert.equal(overview.monitors.find(m => m.kind === 'content').status, 'up')
  assert.ok(app.store.demoMessages().some(message => /AI-разбор/.test(message.text)))
  assert.equal(overview.ai.enabled, true)
  assert.ok(overview.ai.usage.calls >= 2)
  assert.equal((await post('/api/ai/report', { days: 7 })).status, 202)
  assert.equal((await post('/api/ai/report', { days: 99 })).status, 400)
  await settle(app)
  assert.match(app.store.demoMessages().at(-1).text, /AI-отчёт за 7 дн/)
  assert.equal(app.store.getSetting('ai:lastReport').source, 'ai')
})
