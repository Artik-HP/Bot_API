'use strict'

const fixtures = [
  { id: 'demo-web-001', kind: 'http', name: 'Сайт портфолио', target: 'https://portfolio.example/', config: {}, intervalSeconds: 15 },
  { id: 'demo-form-002', kind: 'content', name: 'Форма заявки', target: 'https://portfolio.example/contact', config: { text: 'Оставить заявку' }, intervalSeconds: 15 },
  { id: 'demo-tls-003', kind: 'tls', name: 'SSL-сертификат', target: 'https://portfolio.example', config: { warningDays: 14 }, intervalSeconds: 30 },
  { id: 'demo-ai-004', kind: 'ai-page', name: 'Прайс и заявка (AI)', target: 'https://portfolio.example/pricing', config: { expectation: 'На странице указаны цены услуг в рублях и есть способ оставить заявку' }, intervalSeconds: 30 },
]

const seededSummary = { http: 'HTTP 200', content: 'Контрольная фраза на месте', tls: 'Сертификат: осталось 64 дн.', 'ai-page': 'AI: условие выполнено — цены в рублях и кнопка заявки на месте' }

const pages = {
  '/': '<h1>Артём — разработка Telegram-ботов и интеграций</h1><p>Боты, API, автоматизация для бизнеса.</p><a href="/pricing">Цены</a><a href="/contact">Связаться</a>',
  '/contact': '<h1>Связаться</h1><form><input name="phone"><button>Оставить заявку</button></form>',
  '/pricing': '<h1>Услуги и цены</h1><ul><li>Telegram-бот под ключ — от 45 000 ₽</li><li>Интеграция с API и CRM — от 30 000 ₽</li><li>Поддержка и мониторинг — 9 000 ₽ в месяц</li></ul><button>Оставить заявку</button>',
  // The button text survives, so a phrase check stays green while the prices are gone.
  '/pricing:semantic': '<h1>Услуги</h1><p>Раздел обновляется. Стоимость обсуждается индивидуально.</p><button>Оставить заявку</button>',
}

function seedDemo(store, now = Date.now()) {
  const fresh = store.listMonitors().length === 0
  for (const monitor of fixtures) {
    if (store.getMonitor(monitor.id)) continue
    store.addMonitor(monitor, now - 35 * 60000)
    for (let i = 36; i > 0; i--) {
      const latency = monitor.kind === 'tls' ? 72 + (i % 6) * 5 : 130 + (i % 7) * 14 + (i % 3) * 8
      store.recordCheck(monitor.id, { healthy: true, latencyMs: latency, summary: seededSummary[monitor.kind] }, 2, now - i * 60000)
    }
  }
  if (!fresh) return
  store.subscribe('900001')
  store.setSetting('demoScenario', 'healthy')
  store.addDemoMessage('out', '📡 PulseDesk подключён. Четыре тестовых сервиса работают. Нажми «Запустить сбой», чтобы увидеть полный цикл инцидента.')
}

function createDemoTransport(store) {
  return {
    async http(target) {
      const scenario = store.getSetting('demoScenario', 'healthy')
      const page = new URL(target).pathname
      const down = scenario === 'outage' && page === '/'
      const missing = scenario === 'content' && page === '/contact'
      const text = missing ? '<h1>Страница обновляется</h1>' : pages[scenario === 'semantic' && page === '/pricing' ? '/pricing:semantic' : page] || pages['/']
      return { status: down ? 503 : 200, latencyMs: down ? 1200 : scenario === 'slow' ? 1450 : 165 + Math.floor(Date.now() / 1000) % 61, text: down ? '<h1>503 Service Unavailable</h1><p>nginx</p>' : text }
    },
    async tls() { return { expiresAt: Date.now() + (store.getSetting('demoScenario') === 'certificate' ? 5 : 64) * 86400000 + 60000, latencyMs: 82 } },
  }
}

module.exports = { seedDemo, createDemoTransport }
