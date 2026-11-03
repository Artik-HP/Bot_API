'use strict'

const { Store } = require('./core/store.cjs')
const { createRegistry } = require('./modules/index.cjs')
const { MonitoringService } = require('./core/monitoring.cjs')
const { NotificationWorker } = require('./core/notifications.cjs')
const { Runtime } = require('./core/runtime.cjs')
const { inspectHttp, inspectTls } = require('./core/network.cjs')
const { TelegramTransport, DemoTelegramTransport } = require('./adapters/telegram.cjs')
const { BotRouter } = require('./bot/router.cjs')
const { seedDemo, createDemoTransport } = require('./demo/index.cjs')
const { createHttpServer } = require('./http/server.cjs')
const { OpenRouterClient } = require('./ai/openrouter.cjs')
const { AiService } = require('./ai/service.cjs')

function createApplication(config, overrides = {}) {
  const store = overrides.store || new Store(config.database)
  const registry = overrides.registry || createRegistry()
  if (config.mode === 'demo') seedDemo(store)
  else for (const subscriber of store.db.prepare('SELECT chat_id FROM subscribers').all()) {
    if (!config.allowedUsers.has(subscriber.chat_id)) store.unsubscribe(subscriber.chat_id)
  }
  const transport = overrides.transport || (config.mode === 'demo' ? createDemoTransport(store) : { http: inspectHttp, tls: inspectTls })
  const telegram = overrides.telegram || (config.mode === 'demo' ? new DemoTelegramTransport(store) : new TelegramTransport(config.token))
  const client = 'aiClient' in overrides ? overrides.aiClient : config.ai?.enabled ? new OpenRouterClient(config.ai) : null
  const ai = new AiService({ store, client, config, registry, transport })
  const monitoring = new MonitoringService({ store, registry, transport, config, ai })
  monitoring.observe(event => ai.onTransition(event))
  const notifications = new NotificationWorker(store, telegram)
  const bot = new BotRouter({ store, monitoring, registry, telegram, config, ai })
  const runtime = new Runtime({ store, monitoring, notifications, bot, telegram, config, ai })
  const server = createHttpServer({ config, store, monitoring, registry, notifications, bot, runtime, ai })
  return {
    store, registry, monitoring, notifications, bot, telegram, runtime, server, ai,
    async start() {
      try {
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve) })
        await runtime.start()
        return server.address()
      } catch (error) {
        await runtime.stop()
        if (server.listening) await new Promise(resolve => server.close(resolve))
        store.close()
        throw error
      }
    },
    async stop() {
      const closing = server.listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve()
      server.closeIdleConnections()
      await runtime.stop()
      await closing
      store.close()
    },
  }
}

module.exports = { createApplication }
