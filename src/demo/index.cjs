'use strict'

const fixtures = [
  { id: 'demo-web-001', kind: 'http', name: 'Сайт портфолио', target: 'https://portfolio.example/', config: {}, intervalSeconds: 15 },
  { id: 'demo-form-002', kind: 'content', name: 'Форма заявки', target: 'https://portfolio.example/contact', config: { text: 'Оставить заявку' }, intervalSeconds: 15 },
  { id: 'demo-tls-003', kind: 'tls', name: 'SSL-сертификат', target: 'https://portfolio.example', config: { warningDays: 14 }, intervalSeconds: 30 },
]

function seedDemo(store, now = Date.now()) {
  if (store.listMonitors().length) return
  store.subscribe('900001')
  store.setSetting('demoScenario', 'healthy')
  for (const monitor of fixtures) {
    store.addMonitor(monitor, now - 35 * 60000)
    for (let i = 36; i > 0; i--) {
      const latency = monitor.kind === 'tls' ? 72 + (i % 6) * 5 : 130 + (i % 7) * 14 + (i % 3) * 8
      store.recordCheck(monitor.id, { healthy: true, latencyMs: latency, summary: monitor.kind === 'tls' ? 'Сертификат: осталось 64 дн.' : monitor.kind === 'content' ? 'Контрольная фраза на месте' : 'HTTP 200' }, 2, now - i * 60000)
    }
  }
  store.addDemoMessage('out', '📡 PulseDesk подключён. Три тестовых сервиса работают. Нажми «Запустить сбой», чтобы увидеть полный цикл инцидента.')
}

function createDemoTransport(store) {
  return {
    async http(target) {
      const scenario = store.getSetting('demoScenario', 'healthy')
      const form = target.includes('/contact')
      const down = scenario === 'outage' && !form
      const missing = scenario === 'content' && form
      return { status: down ? 503 : 200, latencyMs: down ? 1200 : scenario === 'slow' ? 1450 : 165 + Math.floor(Date.now() / 1000) % 61, text: missing ? '<h1>Страница обновляется</h1>' : '<button>Оставить заявку</button>' }
    },
    async tls() { return { expiresAt: Date.now() + (store.getSetting('demoScenario') === 'certificate' ? 5 : 64) * 86400000 + 60000, latencyMs: 82 } },
  }
}

module.exports = { seedDemo, createDemoTransport }
