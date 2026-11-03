'use strict'
// Live check of every AI feature against OpenRouter. Uses demo pages and an in-memory base; Telegram is never called.
const path = require('node:path')
const fs = require('node:fs')
const { loadEnvironment, readConfig } = require('../src/config.cjs')
const { Store } = require('../src/core/store.cjs')
const { createRegistry } = require('../src/modules/index.cjs')
const { MonitoringService } = require('../src/core/monitoring.cjs')
const { OpenRouterClient } = require('../src/ai/openrouter.cjs')
const { AiService } = require('../src/ai/service.cjs')
const { seedDemo, createDemoTransport } = require('../src/demo/index.cjs')

async function main() {
  const root = path.resolve(__dirname, '..')
  loadEnvironment(root)
  const config = readConfig(process.env, { root, demo: true })
  if (!config.ai.enabled) throw new Error('Нет PULSE_OPENROUTER_API_KEY в .env.pulsedesk')
  const store = new Store()
  seedDemo(store)
  const registry = createRegistry()
  const transport = createDemoTransport(store)
  const ai = new AiService({ store, client: new OpenRouterClient(config.ai), config, registry, transport })
  const monitoring = new MonitoringService({ store, registry, transport, config, ai })
  monitoring.observe(event => ai.onTransition(event))
  const report = { model: config.ai.model, steps: [] }
  const step = async (name, fn) => {
    const started = Date.now()
    try {
      const value = await fn()
      report.steps.push({ name, ok: true, seconds: (Date.now() - started) / 1000, value })
      console.log(`\n✓ ${name} · ${((Date.now() - started) / 1000).toFixed(1)} с\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`)
    } catch (error) {
      report.steps.push({ name, ok: false, error: error.code || error.message })
      console.log(`\n✖ ${name}: ${error.code || error.message}`)
    }
  }
  const lastMessage = () => store.deliveries().find(item => item.kind === 'message')?.payload.text
  const pricing = store.getMonitor('demo-ai-004')

  await step('AI-проверка: прайс на месте', async () => {
    const page = await transport.http(pricing.target)
    return ai.judgePage({ monitorId: 'smoke-ok', expectation: pricing.config.expectation, text: require('../src/ai/text.cjs').pageText(page.text) })
  })
  await step('AI-проверка: цены пропали, кнопка осталась', async () => {
    store.setSetting('demoScenario', 'semantic')
    for (let i = 0; i < config.failureThreshold; i++) await monitoring.run(pricing.id)
    return { status: store.getMonitor(pricing.id).status, summary: store.getMonitor(pricing.id).summary }
  })
  await step('Разбор инцидента', async () => {
    await ai.drain()
    const incident = store.incidents().find(item => item.monitor_id === pricing.id)
    return incident?.analysis ? require('../src/ai/prompts.cjs').formatAnalysis(incident.analysis) : 'Анализ не появился'
  })
  await step('Разбор сбоя сайта (HTTP 503)', async () => {
    store.setSetting('demoScenario', 'outage')
    for (let i = 0; i < config.failureThreshold; i++) await monitoring.run('demo-web-001')
    await ai.drain()
    const incident = store.incidents().find(item => item.monitor_id === 'demo-web-001')
    return incident?.analysis ? require('../src/ai/prompts.cjs').formatAnalysis(incident.analysis) : 'Анализ не появился'
  })
  await step('Отчёт за 7 дней', async () => { ai.requestReport({ chatId: '900001', days: 7 }); await ai.drain(); return store.getSetting('ai:lastReport').text })
  await step('Вопрос /ask', async () => { ai.requestAnswer('900001', 'Что сейчас сломано и что чинить первым?'); await ai.drain(); return lastMessage() })
  await step('Подбор проверок /scan', async () => {
    store.setSetting('demoScenario', 'healthy')
    ai.requestScan('900001', 'https://portfolio.example/pricing'); await ai.drain(); return lastMessage()
  })

  const usage = ai.overview().usage
  report.usage = usage
  console.log(`\nИтого: ${usage.calls} запросов к ${config.ai.model}, ${usage.tokens} токенов, $${usage.cost.toFixed(4)}`)
  fs.mkdirSync(path.join(root, 'artifacts', 'local'), { recursive: true })
  fs.writeFileSync(path.join(root, 'artifacts', 'local', 'ai-smoke.json'), JSON.stringify(report, null, 2))
  store.close()
  if (report.steps.some(item => !item.ok)) process.exitCode = 1
}

main().catch(error => { console.error(`ai-smoke: ${error.message}`); process.exitCode = 1 })
