'use strict'
const { validateUrl } = require('../../core/network.cjs')
const { fields } = require('../fields.cjs')

module.exports = {
  id: 'content', title: 'Контроль контента', icon: 'scan', command: '/watch',
  description: 'Проверяет, что нужная фраза осталась на странице: форма, кнопка или важный текст.',
  fields: [{ key: 'target', label: 'HTTPS-адрес', placeholder: 'https://example.com', required: true }, { key: 'text', label: 'Контрольная фраза', placeholder: 'Оставить заявку', required: true }],
  fromCommand(args) { const [target, text, name] = fields(args); return { target, name: name || 'Контент страницы', config: { text } } },
  validate(input) {
    const text = input.config?.text
    if (typeof text !== 'string' || !text.trim() || text.length > 160) throw new Error('Контрольная фраза: от 1 до 160 символов')
    return { target: validateUrl(input.target).href, config: { text: text.trim() } }
  },
  async check(monitor, context) {
    const result = await context.transport.http(monitor.target, { signal: context.signal })
    const healthy = result.status >= 200 && result.status < 300 && result.text.includes(monitor.config.text)
    return { healthy, latencyMs: result.latencyMs, summary: healthy ? 'Контрольная фраза на месте' : 'Страница недоступна или контрольная фраза пропала', meta: { status: result.status } }
  },
}
